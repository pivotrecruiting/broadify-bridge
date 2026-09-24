# Task: Engine connection supervisor — mid-session auto-reconnect, cancellable startup connect, join semantics, shutdown disconnect (PR B4)

## Raw request
Audit rc.19 (24.9.2026), HIGH: a dropped ATEM connection (USB cable, hub hiccup, ATEM reboot, IP worker death) stays
`disconnected` until an operator reconnects in the webapp. The only automatic attempt is a one-shot `setTimeout` 3 s after
bridge start (`apps/bridge/src/server.ts` `ENGINE_AUTO_RECONNECT_DELAY_MS` ~226, `scheduleEngineAutoReconnect` ~239-269,
called ~292) that is not cancellable and collides with the webapp Autostart (`ALREADY_CONNECTING` toast for the loser).
The bridge shutdown (`server.ts` ~354-456) never disconnects the engine. Relay `engine_connect` local SLA is 11 s
(`relay-command-policy.ts:87`) while a USB connect after the awaited helper stop (PR B3) can take ≈16 s (< 18 s relay
timeout; the SLA is log-only, `relay-client.ts:865-875`).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/engine-connection-supervisor / feature/engine-connection-supervisor
- Base: be0ccfd9 = merge of feature/atem-ip-reconnect-listeners (PR B2, 61e23854) and feature/atem-usb-helper-stop (PR B3, 04204a37), both on top of
  PR B1. Target dev after those merge.
- Facts to rely on (verified): after B2 the IP adapter reports `connected → connecting` while the atem-connection library
  heals itself (its own 1 s reconnect loop) and `connected` again afterwards; a USB drop reports `connected → disconnected`
  and stops the helper (B3 makes `stopHelper()` awaitable). `EngineAdapterService` (`services/engine-adapter.ts`) is the
  singleton facade used by command-router, routes and server; it has no subscribe API, state changes leave via
  `broadcastStateChanges` (WS + relay events). Webapp tolerates additive fields in `engine_status` (no Zod on engine
  payloads) and maps `connecting` to spinner/locked form. `meeting-helper-manager.ts` has the precedent for
  `beginShutdown()` (~1613-1616) and bounded restart with backoff (~69-73, ~1555-1656); `relay-client.ts` for injectable
  timers (`setTimeoutFn/clearTimeoutFn`, ~368-395) and exponential 1 s→60 s (~1695-1724). vMix adapter flips to `error`
  after polling failures (`vmix-adapter.ts:356-363`) → the supervisor will auto-reconnect vMix too (intended; mention in
  docs).
- Conventions: kebab-case, camelCase, UPPER_SNAKE constants, `T`-suffixed type aliases, English comments/JSDoc, colocated
  tests, fake timers via `jest.useFakeTimers()` + `await jest.advanceTimersByTimeAsync()`.

## Plan
### 1. Shared backoff (`apps/bridge/src/services/shared/backoff.ts` + test) — the ONE implementation other PRs reuse
- `computeBackoffDelayMs({ attempt, baseMs, maxMs, jitterRatio, random })` pure: `min(baseMs * 2^(attempt-1), maxMs)`
  then `delay * (1 + (random()*2-1) * jitterRatio)`, clamped ≥ 0.
- `class ReconnectScheduler` with ctor `{ baseMs, maxMs, jitterRatio, maxAttempts?, setTimeoutFn?, clearTimeoutFn?,
  now?, random? }` and API `schedule(run: () => Promise<void> | void): boolean` (false when maxAttempts exhausted),
  `cancel()`, `reset()`, `isArmed()`, `get attempt`, `getNextRetryAt(): number | null`. Timers `unref`'d.
### 2. Types (`services/engine-types.ts`)
- `export type EngineReconnectInfoT = { attempt: number; nextRetryAt: number | null; lastError?: string }`;
  `EngineStateT += reconnect?: EngineReconnectInfoT | null`. Publisher (`engine-event-publisher.ts`) adds
  `reconnect: state.reconnect ?? null` to `engine_status`.
### 3. `EngineConnectionSupervisor` (`services/engine/engine-connection-supervisor.ts` + test)
- Deps: `driver: { open(config): Promise<void>; close(): Promise<void> }`, `getStatus(): EngineStatusT`,
  `onReconnectStateChange(info: EngineReconnectInfoT | null)`, `createScheduler(kind: "startup" | "session")`, `logger`,
  `now`, timers.
- Constants: `STARTUP_AUTO_CONNECT_DELAY_MS = 3000`, `STARTUP_MAX_ATTEMPTS = 5` (1/2/4/8/16 s), `RECONNECT_BASE_DELAY_MS =
  1000`, `RECONNECT_MAX_DELAY_MS = 30_000`, `RECONNECT_JITTER_RATIO = 0.2`, `SELF_HEAL_GRACE_MS = 30_000`.
- API: `connect(config, origin: "manual" | "startup"): Promise<void>` (manual = one attempt, throws on failure as today;
  startup = bounded loop, silent give-up), `disconnect(): Promise<void>` (desired=null, cancel timers, abandon in-flight,
  `driver.close()`), `handleSessionStatus(prev, next)`, `beginShutdown()`, `cancelPending()`.
- Transitions (only when `desired !== null && !shutdownRequested`): `connected → disconnected|error` unsolicited → Drop →
  session loop: `close()` → fresh adapter → `open(desired)`; on failure `reconnect = { attempt, nextRetryAt, lastError }`
  and next tick; success → `reset()`, `reconnect = null`. `connected → connecting` → Self-Heal: passive, arm grace timer;
  `connected` again → clear; grace expires → Takeover (`close()` = destroy + session loop). `disconnected → disconnected`
  (USB double event) ignored (schedule only when `prev === "connected"`).
### 4. `EngineAdapterService` (`services/engine-adapter.ts`)
- Split today's `connect()` body into `private openSession(config, origin)` and `private closeSession()` (replaces the
  previous-adapter teardown block too). During non-manual attempts do not write `status: "error"`; write `connecting` +
  `reconnect.lastError`.
- Public `connect(config, origin = "manual")`: guards → Join semantics: same config in-flight → return the in-flight
  promise; in-flight non-manual with different config → cancel it and start the manual one; in-flight manual with different
  config → `ALREADY_CONNECTING` (unchanged); pending retry/self-heal → cancel and take over `desired`. `disconnect()` cancels
  everything. `startPersistedAutoConnect()` (3 s timer, injectable) → `deps.loadPersistedConnection()` → if `status ===
  "disconnected"` → `connect(cfg, "startup")`. `beginShutdown()`. Deps += `loadPersistedConnection`, timers, `random`.
- `broadcastStateChanges`: a change of `reconnect` counts as status change; reason `"reconnecting"` when `reconnect` set.
- Helper `isSameEngineConnectConfig(a, b)` in `engine/engine-connect-schema.ts`.
### 5. `server.ts`
- Remove `scheduleEngineAutoReconnect` + constant + call; call `engineAdapter.startPersistedAutoConnect()` after listen.
- Shutdown: `engineAdapter.beginShutdown()` as the FIRST line (next to `meetingHelperManager.beginShutdown()`), and after
  `stopCommandRouter()` add `await withTimeout("engine disconnect", engineAdapter.disconnect(), 7000)` before the relay
  disconnect (so the final `engine_status disconnected` still reaches the relay).
- `server.test.ts`: engine mock gains `startPersistedAutoConnect`, `beginShutdown`, `disconnect`; the old timer tests
  (~543-598) move to `engine-adapter.test.ts`; shutdown test asserts order.
### 6. Relay SLA
- `relay-command-policy.ts:87`: `engine_connect` `bridgeLocalSlaMs` 11_000 → 17_000 (relay timeout stays 18 s); update the
  table in `docs/bridge/features/relay-protocol.md` (~154-160).
### 7. Docs
- `docs/bridge/features/engine-connection-lifecycle.md` (created in B2): supervisor state machine, constants, join table
  (manual vs startup vs in-flight), vMix note; `docs/bridge/reference/files/server.md` (startup auto-connect moved,
  shutdown order); `docs/bridge/dataflows.md` (`reconnect` field).

## Acceptance criteria (RED before unless guard)
1. `backoff.test.ts`: caps at maxMs, symmetric jitter within ratio, deterministic with injected random, `cancel()` prevents
   the callback, `schedule` returns false after maxAttempts.
2. `engine-connection-supervisor.test.ts` (fake timers): "reconnects after an unsolicited drop with exponential backoff"
   (close→open order, delays 1 s/2 s/4 s); "stays passive during self-heal and takes over after the grace period"; "manual
   disconnect cancels a pending retry"; "beginShutdown suppresses reconnects on later drops"; "startup gives up after
   STARTUP_MAX_ATTEMPTS and closes silently"; "resets backoff after a successful reconnect"; "ignores disconnected→disconnected".
3. `engine-adapter.test.ts`: "publishes connecting with reconnect info while an auto-reconnect is pending" (no `engine.error`
   broadcast) — RED before; "auto-reconnects a usb drop through a fresh adapter" (createAdapter twice, old adapter
   disconnected first) — RED before; "startPersistedAutoConnect connects the persisted config after the delay" (migrated
   from server.test.ts); "startPersistedAutoConnect does nothing when already connecting"; "joins an in-flight auto attempt
   with the same config instead of throwing ALREADY_CONNECTING" — RED before; "supersedes an in-flight startup attempt when
   the manual config differs" — RED before; "still rejects a second manual connect with a different config while
   connecting" (guard); "a manual disconnect cancels the startup auto-connect timer" — RED before.
4. `server.test.ts`: "shutdown begins engine shutdown first and disconnects the engine before the relay" — RED before.
5. All existing engine/adapter/router/route suites green; `relay-command-policy.test.ts` green.
6. `npx jest apps/bridge/src/services/shared apps/bridge/src/services/engine apps/bridge/src/services/engine-adapter.test.ts
   apps/bridge/src/services/command-router.test.ts apps/bridge/src/server.test.ts apps/bridge/src/services/relay-command-policy.test.ts --runInBand`
   green; FULL `npm run test:jest` (verifier); `npm run lint`; `npm run build:bridge`.

## Review
- Round: 1/3
- Verdict: Applied review round 1 MUST-FIX items.
- Must-fix (applied): identity-guarded superseded adapter cleanup; generation invalidation for new desired configs; startup give-up resets service state to disconnected; startup attempt budget owned by supervisor.
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Files changed: shared backoff/scheduler, engine connection supervisor, EngineAdapterService integration, server startup/shutdown lifecycle, relay SLA/tests, engine event payload tests, and the docs listed in the task.
- Deviation: full `npm run test:jest` remains red only for pre-existing `electron-renderer-client.test.ts` `listen EPERM 127.0.0.1`; confirmed by temporarily reversing this task's changes and rerunning the same command.

## Verification
- [ ] Tests pass (targeted + full)
- [x] Lint / type-check pass
- [ ] Hardware outcome check (verifier): USB cable pull 20 s → `connecting` + rising `reconnect.attempt` → `connected`
      within ≤30 s after replug, exactly one helper; IP: Wi-Fi off 10 s → self-heal; ATEM off 2 min → takeover; bridge
      restart with ATEM → connected after ~3 s; without ATEM → 5 attempts then quiet `disconnected`; Autostart collision →
      no ALREADY_CONNECTING
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
