# Task: ATEM USB adapter — awaitable helper stop with escalation, spawn guard (PR B3)

## Raw request
Audit rc.19 (24.9.2026), HIGH: `apps/bridge/src/services/engine/adapters/atem-usb-adapter.ts` `stopHelper()` (~468-497)
writes `{"command":"shutdown"}` to the helper's stdin, arms SIGTERM (4 s) / SIGKILL (+2 s) timers and returns
immediately; `disconnect()` (~224-241) is `async` but awaits nothing and resets the state at once; `connect()` has no
guard against a still-running previous helper. Result: an operator who clicks "Verbinden" right after a USB drop spawns
a second `atem-usb-helper` while the first still holds the switcher (SDK `Release()` in `disconnectLocked`) → the new
helper's `ConnectTo("")` fails with `no_usb_switcher_found`; the second click a few seconds later works. The same
escalation pattern (graceful request → SIGTERM → SIGKILL, awaited on `exit`) already exists twice:
`apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts` ~194-230 and
`apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts` ~425-465.

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/atem-usb-helper-stop / feature/atem-usb-helper-stop
- Base: feature/engine-error-codes (PR B1, 84b14e34 — stacked; target dev after B1 merges). PR B2 (IP adapter) is
  developed in parallel on the same base and does not touch this file.
- No native helper change, no protocol change (heartbeat/ack come with the helper batch), no reconnect loop (PR B4).
- Conventions: kebab-case, camelCase, `T`-suffixed type aliases where established, English comments/JSDoc, colocated
  tests, `npx jest <path> --runInBand`, fake timers via `jest.useFakeTimers()` + `await jest.advanceTimersByTimeAsync()`.
  Existing test fake: `atem-usb-adapter.test.ts` (`jest.mock("node:child_process")`, EventEmitter child with
  `stdout/stderr/stdin.write/kill`, `emitHelperLine`, `flush`).

## Plan
1. New shared utility `apps/bridge/src/services/shared/child-process-exit.ts` (+ `child-process-exit.test.ts`):
   - `hasChildExited(child): boolean` (via `exitCode !== null || signalCode !== null`).
   - `awaitChildExit(child): Promise<void>` (resolves immediately when already exited, else on `exit`).
   - `stopChildProcessWithEscalation(child, { requestShutdown: () => void; gracefulMs; forceMs; setTimeoutFn?;
     clearTimeoutFn? }): Promise<void>` — call `requestShutdown()` (errors swallowed), wait up to `gracefulMs` for exit,
     then `kill("SIGTERM")`, wait `forceMs`, then `kill("SIGKILL")`, resolve on `exit` (or right after SIGKILL if the exit
     never comes — bounded); timers are `unref`'d and cleared on exit. Pure, no logger dependency (callers log).
   This is the DRY home for the pattern; refactoring the two existing copies is OUT of scope (follow-up).
2. `atem-usb-adapter.ts`:
   - `private stopping: Promise<void> | null = null;`
   - `stopHelper(): Promise<void>`: if `this.stopping` exists return it; if no process resolve; else detach
     `this.process = null` and `this.stopping = stopChildProcessWithEscalation(child, { requestShutdown: () =>
     child.stdin?.write('{"command":"shutdown"}\n'), gracefulMs: SHUTDOWN_SIGTERM_DELAY_MS (4000), forceMs:
     SHUTDOWN_SIGKILL_DELAY_MS (2000) }).finally(() => { this.stopping = null; })`. Remove `shutdownTimers` /
     `clearShutdownTimers` (~145, ~499-504) — the utility owns the timers.
   - `disconnect()` (~224-241): `await this.stopHelper()` BEFORE the state reset (so `disconnected` is only reported once
     the claim is released).
   - `failConnect` (~432-445) and the `disconnected` case (~374-386): `void this.stopHelper()` (a reject must not wait).
   - `handleHelperExit` (~447-462): keep behaviour; the utility resolves on the same `exit` event.
   - Spawn guard in `connect()` after the state/access checks (~155-166): `if (this.stopping) { await this.stopping; }` and
     if a process is still tracked afterwards throw `new EngineError(EngineErrorCode.UNKNOWN_ERROR, "ATEM USB helper is
     still running")`.
3. Test fake: extend `createMockChild` with `exitCode: null`, `signalCode: null`; let tests set them and emit `exit` to
   simulate the helper ending (do NOT make `kill` auto-exit by default — the escalation test needs a helper that ignores
   shutdown and SIGTERM).

## Acceptance criteria (RED before unless marked guard)
1. `atem-usb-adapter.test.ts` NEW "disconnect resolves only after the helper exited": call `disconnect()`, assert it is
   still pending after `flush()`, emit `exit` → resolves, state `disconnected`. RED before (resolves immediately).
2. NEW "escalates to SIGTERM and SIGKILL when the helper ignores shutdown" (fake timers): after 4000 ms `kill` called with
   "SIGTERM", after 6000 ms with "SIGKILL"; `disconnect()` resolves after SIGKILL + exit. RED before for the awaited part
   (today `disconnect()` resolves at once).
3. NEW "connect waits for a pending helper stop before spawning again": disconnect (helper not yet exited) then connect →
   `spawn` NOT called until the old child emits `exit`; then exactly one new spawn. RED before (immediate second spawn).
4. `child-process-exit.test.ts`: "resolves immediately for an exited child", "runs shutdown→SIGTERM→SIGKILL escalation
   with the given delays", "clears timers when the child exits early".
5. Existing tests stay green (`atem-usb-adapter.test.ts` all cases, `engine-adapter.test.ts`, `adapter-factory.test.ts`).
6. `npx jest apps/bridge/src/services/shared apps/bridge/src/services/engine apps/bridge/src/services/engine-adapter.test.ts --runInBand`
   green; FULL `npm run test:jest` (verifier, outside the sandbox); `npm run lint`; `npm run build:bridge`.
7. Docs: `apps/bridge/native/atem-usb-helper/README.md` (or the docs/bridge file that documents the USB adapter lifecycle —
   find it with `rg -l "atem-usb" docs/bridge`) gets a short "Lifecycle: stop is awaited, escalation 4 s / +2 s, spawn
   guard" paragraph.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Files changed: shared child-process exit utility/tests, ATEM USB adapter/tests, ATEM USB helper README lifecycle docs.
- Deviations: `connect()` waits for `this.stopping` before the connected/connecting status check so an immediate reconnect during an in-flight `disconnect()` can wait for the old helper instead of throwing "already connected"; this is required by the spawn-guard acceptance test. Full `npm run test:jest` is red in this sandbox due `electron-renderer-client.test.ts` `listen EPERM 127.0.0.1`; proving it with `git stash` was blocked because `.git` is read-only (`could not write index`).

## Verification
- [ ] Tests pass (targeted + full `npm run test:jest`)
- [x] Lint / type-check pass (`npm run lint`, `npm run build:bridge`)
- [ ] Hardware outcome check (verifier, ATEM via USB): drop → immediate reconnect click succeeds on the first try;
      `pgrep atem-usb-helper` shows exactly one process
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
