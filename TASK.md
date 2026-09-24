# Task: Output helper lifecycle session, output supervisor with device-change re-apply, honest startup status (PR C2)

## Raw request
Audit rc.19 (24.9.2026), Studio graphics (macOS DeckLink + display output):
- G2 (HIGH): when the DeckLink/display helper exits AFTER `ready` (device unplugged, Desktop Video restarted, helper
  crash) the adapters only log (`graphics/output-adapters/decklink-key-fill-output-adapter.ts` ~139-153,
  `decklink-video-output-adapter.ts` ~135-149, `display-output-adapter.ts` ~153-167); `GraphicsOutputAdapter`
  (`graphics/output-adapter.ts:13-31`) has no lifecycle hook; `graphics-manager.ts` never learns about it → webapp keeps
  showing `outputStatus: "ready"` / on air while the SDI output is black. The three adapters have NO ready timeout
  (`await this.readyPromise` without timer), so a hung helper blocks the transition until the relay timeout.
- G3 (HIGH): a failed persisted apply at startup (cold-start race: Desktop Video not ready yet → helper
  "DeckLink device not found") is reported once via `publishGraphicsError`, but `graphics-manager.ts` `initialize()`
  (~308-311) then overwrites `outputStatus` to `unconfigured` and `lastOutputError` to null; there is no retry and no
  reaction to the device appearing later (`device-cache.ts` has no change notification; watch only refreshes the cache
  ~210-253). Operators see "unconfigured" without any error and must reconfigure by hand.
- G9 (MEDIUM): the ready rejection message is generic ("exited before ready (code 1, signal null)"); helper stderr with the
  real cause is only in the bridge log.
- G10 (part): the DeckLink watch process is not restarted when it dies (PR C3 only logs the exit).
- G7 (TS part): no ready timeout.

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/graphics-output-supervisor / feature/graphics-output-supervisor
- Base: merge of feature/device-protocol-diagnostics (PR C3, 137fd9fc) and feature/engine-connection-supervisor (PR B4, 7206c8e7) (provides
  `apps/bridge/src/services/shared/backoff.ts` with `ReconnectScheduler` — REUSE it; do not write a second backoff).
  Target dev after those merge.
- Hard rules (AGENTS.md): Graphics Single-Path — no fallback renderer/compositing; docs under docs/bridge/* in the same
  change. No native helper change (the helper batch adds `playback_started`/`fatal`/`helperVersion` events later; TS must
  already parse them tolerantly and work with the CURRENT helper that only emits `ready`/`metrics`).
- Facts (verified): the relay publishes `get_status` snapshots on every connect and the webapp calls
  `refreshGraphicsStatus()` on `webapp_subscribed`, so a persisted `error` state becomes visible without any
  server.ts re-ordering — keep `server.ts` untouched. `graphics-runtime-init-service.ts` keeps the persisted config on
  failure (~138-146). `graphics-output-transition-service.ts` `runAtomicTransition` serialises transitions.
  `device-cache.test.ts` injects deps and captures the `watchAll` callback (~35-58).
- Conventions: kebab-case, camelCase, `T`-suffixed type aliases, English comments/JSDoc, colocated tests, fake timers via
  `jest.useFakeTimers()` + `await jest.advanceTimersByTimeAsync()`.

## Plan
### 1. `HelperProcessSession` (new `graphics/output-adapters/helper-process-session.ts` + test)
Encapsulates what the three adapters duplicate: spawn, line-buffered stdout JSON parsing, stderr ring (last 20 lines),
ready promise WITH timeout, exit tracking, stop sequence.
```ts
export type HelperLifecycleEventT =
  | { type: "playback_started" }
  | { type: "fatal"; code: string; message: string }
  | { type: "exited"; code: number | null; signal: NodeJS.Signals | null; requested: boolean; lastStderr: string[]; fatal?: { code: string; message: string } };
export type HelperProcessSessionOptionsT = { label: string; helperPath: string; args: string[]; env: NodeJS.ProcessEnv;
  stdin: "pipe" | "ignore"; readyTimeoutMs: number; stderrRingSize?: number;
  stopStrategy: { shutdownHeader?: Buffer; gracefulMs: number; forceMs: number }; logger: LoggerLikeT };
export class HelperProcessSession { start(): Promise<void>; stop(): Promise<void>; onLifecycle(cb): () => void; get helperVersion(): string | null; }
```
`start()` resolves on `{"type":"ready"}` (records `helperVersion` if present), rejects on error/exit/timeout with a
message that includes the last stderr lines and any `fatal.code`. Unknown message types are ignored (debug log).
`stop()` sets `requested = true` (no `exited` event with `requested=false`), writes the shutdown header (DeckLink) or
sends SIGTERM immediately (display), escalates SIGTERM/SIGKILL with the given delays — reuse
`services/shared/child-process-exit.ts` (`stopChildProcessWithEscalation`, from PR B3) instead of re-implementing timers.
Ready timeout: DeckLink 12_000 ms, display 8_000 ms.
### 2. Adapters delegate to the session
The three adapters keep validation + argument building; `configure()` creates a session and awaits `start()`; `stop()`
awaits `session.stop()`; new optional `onLifecycle(cb)` forwards session events. `output-adapter.ts` gets
`onLifecycle?(cb: (event: HelperLifecycleEventT) => void): () => void` and exports the type. Stub adapter unchanged.
Existing adapter tests (spawn mocks) must stay green; add per-adapter "forwards helper exit after ready to onLifecycle".
### 3. `DeviceCache.onDevicesChanged`
`onDevicesChanged(cb: (change: { moduleName: string; added: string[]; removed: string[]; devices: DeviceDescriptorT[] })
=> void): () => void` — emitted after a successful detection in `getDevices()` and after the debounced watch refresh when
the fingerprint (`id|present|ready|inUse` per device) changed; `clear()` drops listeners.
### 4. `GraphicsOutputSupervisor` (new `graphics/graphics-output-supervisor.ts` + test)
Deps: `reapply(config)` (runs the manager's atomic transition), `subscribeDevices` (DeviceCache.onDevicesChanged),
`createScheduler()` (→ `new ReconnectScheduler({ baseMs: 2000, maxMs: 60_000, jitterRatio: 0.2, maxAttempts: 6 })`),
`isTargetPresent(config)` (via `findCachedDevicePortById`), `publishStatus(reason)`, `logger`, `now`.
`start({ reason: "init_failed" | "helper_exit" | "device_changed", config })`, `cancel(reason)`, `reset()`, `getState()`.
Behaviour: schedule with backoff; a device change whose added ids include a target port triggers an immediate attempt
(`scheduler.reset()`); no overlapping attempts; after `maxAttempts` only device events; every attempt publishes
`outputs_configuring`/error like a manual configure.
### 5. `graphics-manager.ts`
- `graphics-runtime-init-service.ts` `initialize()` returns `{ persistedApplyFailed: boolean; persistedConfig }`; the manager
  keeps `outputStatus = "error"` and `lastOutputError` when the apply failed (no reset to `unconfigured`) and starts the
  supervisor with `init_failed`; snapshot gets additive `pendingOutputConfig: GraphicsOutputConfigT | null` and
  `outputRecovery: { active, reason, attempt, nextRetryAt } | null` (publisher passes them through).
- `attachOutputAdapterLifecycle(adapter)` in `setRuntime`/`setOutputAdapter`: `exited && !requested` →
  `reportGraphicsError("output_helper_error", "<label> exited (code, signal)<fatal code/message><last stderr>")` →
  `supervisor.start({ reason: "helper_exit", config })`. `playback_started` → log. `fatal` buffered until exit.
- `configureOutputs` → internal `applyOutputConfig(config, { source: "manual" | "supervisor" })`; manual cancels the
  supervisor first and `reset()`s on success; `shutdown()` cancels.
- Meeting graphics managers (`meeting-graphics-manager.ts`) get the supervisor only for `helper_exit` (they use stubs → it
  never fires) and no persisted retry.
### 6. Watch restart (G10 rest)
`modules/decklink/decklink-helper.ts` `watchDecklinkDevices`: on `exit`/`close` restart via `ReconnectScheduler`
(1 s → 30 s, maxAttempts 8, then one `logger.error`); unsubscribe cancels. Replace the C3 "log once" handler.
### 7. Docs
`docs/bridge/subsystems/graphics.md` ("Output-Supervisor (Self-Heal)", startup error visibility), `subsystems/output-helper.md`
(lifecycle events, ready timeouts, stderr in errors), `architecture/graphics-realtime-output-helper-contract.md`
(`playback_started`/`fatal`/`helperVersion` additive, old helper compatible), `reference/files/{output-adapter-decklink-key-fill.md,
output-adapter-decklink-video.md, decklink-helper-cpp.md}` (fix stale "RGBA via stdin" statements), `graphics-manager.md`,
`device-cache.md`, `subsystems/device-discovery.md` (watch restart).

## Acceptance criteria (RED before unless guard)
1. `helper-process-session.test.ts`: resolves on ready; rejects with last stderr lines when the helper exits before
   ready; rejects after readyTimeoutMs and kills the child (fake timers); emits `exited` with `requested=false` after
   ready; no `exited` when `stop()` requested it; attaches `fatal` code to `exited`; parses `helperVersion`; ignores unknown
   message types.
2. Adapter tests: existing suites green; NEW "forwards helper exit after ready to onLifecycle" per adapter (RED before:
   no hook).
3. `graphics-manager.test.ts`: "reports output_helper_error and starts the supervisor when the active adapter exits after
   ready" (RED before); "keeps lastOutputError and outputStatus=error when the persisted apply fails during initialize"
   (RED before: ~309-310 resets); "publishes pendingOutputConfig while recovery is active"; "manual configureOutputs cancels
   the supervisor".
4. `graphics-output-supervisor.test.ts` (fake timers): retries with capped backoff until success; stops after maxAttempts
   and waits for device changes; reapplies immediately when the target device reappears; cancel prevents further attempts;
   no overlapping attempts.
5. `device-cache.test.ts`: "notifies onDevicesChanged after a watch refresh that changes the device set" (RED before),
   "does not notify when the fingerprint is unchanged", "unsubscribe stops notifications".
6. `graphics-runtime-init-service.test.ts`: "returns persistedApplyFailed=true and keeps the persisted config".
7. `decklink-helper.test.ts`: "restarts the watch helper with backoff after exit", "stops restarting after maxAttempts".
8. `npx jest apps/bridge/src/services/graphics apps/bridge/src/services/device-cache.test.ts apps/bridge/src/modules/decklink --runInBand`
   green; FULL `npm run test:jest` (verifier, outside the sandbox); `npm run lint`; `npm run build:bridge`.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Changed helper lifecycle/session handling in `apps/bridge/src/services/graphics/output-adapters/*`, `graphics-manager.ts`, `graphics-output-supervisor.ts`, `device-cache.ts`, and `modules/decklink/decklink-helper.ts`.
- Added focused Jest coverage for helper session lifecycle, adapter exit forwarding, manager recovery state, supervisor retry/device-change behavior, device-cache notifications, runtime-init result reporting, and DeckLink watch restart.
- Updated the listed `docs/bridge/*` files for Output-Supervisor recovery, helper lifecycle/ready timeouts, additive helper events, device-cache notifications, watch restart, and FrameBus-only playback.
- Deviation: full/targeted Jest are not green in this sandbox because `electron-renderer-client.test.ts` cannot bind `127.0.0.1` (`listen EPERM`). `git stash` proof was blocked by sandbox Git-index write permissions; a direct Node listen probe reproduces the same EPERM.

## Verification
- [ ] Tests pass (targeted + full)
- [x] Lint / type-check pass
- [ ] Hardware outcome check (verifier, UltraStudio): unplug mid-show → `output_helper_error` in the webapp within ~3 s,
      replug → output returns via device event without manual reconfigure; cold start with device late → status `error`
      with cause, then self-heal
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
