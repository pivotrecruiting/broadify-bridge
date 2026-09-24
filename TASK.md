# Task: ATEM IP adapter — survive library reconnects, destroy on cleanup, tolerant connect errors (PR B2)

## Raw request
Audit rc.19 (24.9.2026), CRITICAL: `apps/bridge/src/services/engine/adapters/atem-adapter.ts` registers the
atem-connection `connected` event with `.once` (line ~170). The library reconnects by itself after any short outage
(`node_modules/atem-connection/dist/lib/atemSocketChild.js:47-66, 96-113`: reconnect loop every 1 s, `restartConnection`
also after ~600 ms packet loss with a command in flight) and emits `connected` again (`dist/atem.js:52-55, 127-131`),
but the adapter has no listener left: status stays `disconnected`, every macro run fails with "Engine is not connected"
although the ATEM answers again; `stateChanged` (registered with `.on`) keeps updating the macro list of a "disconnected"
engine. Only manual disconnect + connect helps. MEDIUM: `disconnect()` calls `atemConnection.disconnect()` (~284) but never
`destroy()` — `destroy()` (`dist/lib/atemSocket.js:39-51`) is what kills the threadedclass worker and removes the exit
hook, so every connect cycle leaks a worker thread + UDP socket. LOW (verified): the library emits `error` only as
STRINGS (`atemSocket.js:117,148`, `atem.js:117` "MutateState failed…", "Failed to deserialize command…"); UDP socket
errors are only logged (`atemSocketChild.js:150-157`). The adapter's connect-phase `once("error")` therefore rejects the
connect on harmless library strings; the ECONNREFUSED/ENOTFOUND branches (~114-139) are never hit in practice (IP
connects fail only via the 10 s timeout). `atem.connect()` returns a Promise (`dist/atem.d.ts:52`) that is neither
awaited nor caught (~181).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/atem-ip-reconnect-listeners / feature/atem-ip-reconnect-listeners
- Base: feature/engine-error-codes (PR B1, commit 84b14e34 — stacked; B1 already adds `errorCode` to the state and
  keeps EngineError codes). Target after B1 merges: dev.
- No supervisor / bridge-side reconnect loop in this PR (that is PR B4). No helper/USB changes.
- Conventions: kebab-case, camelCase, `T`-suffixed type aliases where established, English comments/JSDoc, Zod for
  inputs, colocated tests, `npx jest <path> --runInBand`, fake timers via `jest.useFakeTimers()` +
  `await jest.advanceTimersByTimeAsync()` (existing precedent in atem-adapter.test.ts ~140-150, 338-347).

## Plan
1. Listener lifecycle in `atem-adapter.ts`:
   - Replace the connect()-local promise handles with instance fields `connectSettled`, `connectResolve`,
     `connectReject`; add `atemConnectedListener` next to the existing listener fields (33-46).
   - Register `atem.on("connected", onConnected)` (not once). Merge `once("error", onError)` and
     `on("error", onRuntimeError)` into ONE `on("error", onAtemError)` handler that dispatches by phase
     (`connectSettled ? runtime : connectPhase`).
   - `onConnected`: clear the connect timeout, `setState({ status: "connected", error: undefined, errorCode: undefined })`,
     `updateMacrosFromState()`; resolve the connect promise only the first time (`connectSettled` guard). Every later
     `connected` (library reconnect) re-applies status + macros.
   - `onDisconnected` (~151-155): when `status === "connected"` → `setState({ status: "connecting", error: undefined })`
     (the library is healing itself; the supervisor in B4 will treat `connected→connecting` as self-heal). Do NOT clear
     the macro list (the library sets `_state = undefined`; `updateMacrosFromState` returns early ~468-470; the refresh
     comes with the next `connected`).
   - `void atem.connect(ip, port).catch((error) => onAtemError(error instanceof Error ? error : new Error(String(error))))`
     instead of the bare call (~181).
   - Centralise listener removal in `detachAtemListeners(atem)` (today duplicated at ~194-201, ~227-238, ~266-283) and
     make sure `connected`/`error` listeners are removed in `disconnect()` too.
2. Cleanup with `destroy()`: `disconnect()` (~284) → `await this.atemConnection.destroy()` (destroy calls disconnect
   internally first — verified in `atemSocket.js:39-51`); timeout cleanup (~187) and catch cleanup (~232) →
   `void atem.destroy().catch(() => {})`. Detach listeners BEFORE destroy so the internal `disconnected` does not flip
   status to `connecting`.
3. Tolerant connect errors: during the connect phase, only `Error` instances (from the `.catch` above) and the timeout
   reject the connect; library STRING errors are logged at debug and ignored. After connect, keep today's runtime
   behaviour (`onRuntimeError` sets `error` only). Keep the existing message-based classification for real `Error`s.
4. Test mock (`atem-adapter.test.ts` ~33-62): `connect` returns a Promise, add `destroy: mockAtemDestroy`, allow emitting
   a second `connected` and a `disconnected` from the test; `listenerCount` accessible for the duplicate-listener test.

## Acceptance criteria (each "RED before" must be shown failing before the fix)
1. "re-enters connected and refreshes macros after a library-internal reconnect": emit `disconnected`, change the
   mock state (new macro name), emit `connected` → `getStatus() === "connected"`, macros reflect the new state. RED before
   (status stays disconnected, once-listener).
2. "reports connecting while the library reconnects": after `disconnected` from a connected state → `connecting`.
   RED before (`disconnected`).
3. "resolves the connect promise only once across repeated connected events" (resolve spy / promise settles once).
4. "does not register duplicate listeners across connect cycles": after connect → disconnect → connect,
   `listenerCount("connected") === 1` and `listenerCount("error") === 1`. RED before for `error` (two listeners) if the
   test is written against the combined handler; otherwise document as guard.
5. "routes a rejected atem.connect() promise into the connect error path": mock `connect` → `Promise.reject(new
   Error("ECONNREFUSED"))` → connect rejects with `CONNECTION_REFUSED` without waiting for the 10 s timeout. RED before
   (unhandled rejection / timeout).
6. "disconnect destroys the atem instance (not just disconnect)", "connect timeout destroys the half-open instance",
   "connect failure destroys the instance". RED before (`destroy` never called).
7. "does not reject the connect attempt on a library-internal string error": emit `"MutateState failed: …"` before
   `connected` → connect still resolves on `connected`. RED before. The existing test "handles string error in onError"
   (~131) must be rewritten to the new behaviour (it documented the bug).
8. Existing suites green: `atem-adapter.test.ts`, `engine-adapter.test.ts`, `adapter-factory.test.ts`,
   `routes/engine*.test.ts`.
9. `npx jest apps/bridge/src/services/engine apps/bridge/src/services/engine-adapter.test.ts apps/bridge/src/routes --runInBand`
   green; FULL `npm run test:jest` green (verifier runs it outside the sandbox); `npm run lint`; `npm run build:bridge`.
10. Docs: new `docs/bridge/features/engine-connection-lifecycle.md` (section "ATEM IP: library self-heal → status
    connecting → connected"; note that a bridge-side supervisor follows in a later PR) linked from `docs/bridge/README.md`;
    `docs/bridge/reference/files/atem-adapter.md` (if present) updated.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Files changed: `apps/bridge/src/services/engine/adapters/atem-adapter.ts`, `apps/bridge/src/services/engine/adapters/atem-adapter.test.ts`, `docs/bridge/README.md`, `docs/bridge/features/engine-connection-lifecycle.md`, `TASK.md`.
- Implemented persistent ATEM `connected` handling, phase-aware single `error` handling, listener detach helper, `destroy()` cleanup for disconnect/failed connect/timeout, and tolerant connect-phase string errors.
- No `docs/bridge/reference/files/atem-adapter.md` update was made because that file is not present in this worktree.
- Full `npm run test:jest` is red in this sandbox due to pre-existing `listen EPERM: operation not permitted 127.0.0.1` failures in `apps/bridge/src/services/graphics/renderer/electron-renderer-client.test.ts`; the same failure reproduced with the ATEM adapter/test patch temporarily reversed.

## Verification
- [ ] Tests pass (targeted + full `npm run test:jest`)
- [x] Lint / type-check pass (`npm run lint`, `npm run build:bridge`)
- [ ] Hardware outcome check (verifier, ATEM 192.168.178.70 reachable on this Mac): connect via IP, disable Wi-Fi/LAN
      for 10 s, re-enable → status `connecting` then `connected`, macros refreshed, no manual reconnect
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
