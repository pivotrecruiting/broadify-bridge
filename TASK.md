# Task: Engine error codes end-to-end, connection persistence in service, IPv4 trim (PR B1)

## Raw request
Audit rc.19 (24.9.2026): engine errors reach the webapp without their machine-readable code
(`command-router.ts` narrows on `GraphicsError` only), `EngineAdapterService.runMacro/stopMacro` wrap
`EngineError` into a plain `Error`, `publishEngineErrorEvent` is only ever called with the literal
`"engine_error"`, HTTP `POST /engine/connect` does not persist the connection (only the relay command does),
and the `ip` schema rejects surrounding whitespace.

## Context
- Customer / project: Broadify Bridge (apps/bridge), all ATEM/vMix/Tricaster users
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/engine-error-codes / feature/engine-error-codes
- Base branch: dev (origin/dev dd5d6932 == v0.27.1-rc.19)

## Plan
Scope is EXACTLY the four items below. No supervisor, no reconnect logic, no adapter protocol changes.

### 1. Shared error-code helper (new)
- New file `apps/bridge/src/services/shared/error-code.ts` exporting
  `getErrorCode(error: unknown): string | undefined` — returns `error.code` when `error` is an object whose
  `code` property is a non-empty string (covers `GraphicsError` (graphics/graphics-errors.ts:7-15),
  `EngineError` (engine/engine-errors.ts:30-), Node system errors). Duck-typed on purpose (jest module mocks
  break `instanceof`). Colocated test `error-code.test.ts`.
- `apps/bridge/src/services/command-router.ts:746`: replace
  `const errorCode = error instanceof GraphicsError ? error.code : undefined;` with `getErrorCode(error)`.
  Keep the `GraphicsError` import only if still used elsewhere in the file.

### 2. EngineError codes survive the service and the event publisher
- `apps/bridge/src/services/engine-adapter.ts` `runMacro` (~249-267) and `stopMacro` (~272-290): if the adapter
  throws an `EngineError`, rethrow it unchanged; otherwise wrap as today but as
  `new EngineError(EngineErrorCode.UNKNOWN_ERROR, "Failed to run macro N: <msg>")` (same message text as today).
- Add optional `errorCode?: string` to `EngineStateT` (`apps/bridge/src/services/engine-types.ts:57-68`).
  Set it wherever an `EngineError` is turned into `status: "error"`:
  `engine/adapters/atem-usb-adapter.ts` `failConnect` (~432-445: `errorCode: error.code`),
  `engine/adapters/atem-adapter.ts` connect error/timeout paths (~141-144, ~208-211),
  `engine-adapter.ts` connect catch blocks (~179-188, ~201-210: `errorCode: getErrorCode(error)`).
  Clear it (`errorCode: undefined`) on transitions to `connected`/`disconnected` where `error: undefined` is set today.
- `engine-adapter.ts` `broadcastStateChanges` (~337-459): `publishEngineErrorEvent(state.errorCode ?? "engine_error",
  state.error)` instead of the literal; include `code: state.errorCode` in the WS `engine.error` broadcast
  (~382-395). Treat an `errorCode` change like a status change for `didStatusChange`.
- `engine/engine-event-publisher.ts` `publishEngineStatusEvent` (~10-36): add `errorCode: state.errorCode ?? null`.

### 3. Persistence moves into the service (E10)
- `EngineAdapterServiceDepsT` (`engine-adapter.ts:29-35`) gets `persistConnection?: (config: EngineConnectConfig)
  => Promise<void>` (default `engineConnectionStore.save`). After a SUCCESSFUL `connect()` call
  `await deps.persistConnection(config)` (errors logged via bridge context logger at warn level, never thrown —
  `engineConnectionStore.save` already swallows).
- Remove the `await engineConnectionStore.save(connectConfig)` block from `command-router.ts` (~208-211) and the
  now-unused import. Adjust `command-router.test.ts` (~274-315) accordingly (the store mock may stay).
- HTTP `routes/engine.ts` needs no change: it calls the service and therefore persists now.

### 4. IPv4 trim (E11)
- `apps/bridge/src/services/engine/engine-connect-schema.ts:15`: `ip: z.string().trim().ip({ version: "v4" }).optional()`
  (zod 3.25.76 — `.trim()` before `.ip()` verified chainable).

## Acceptance criteria
1. `command-router.test.ts`: NEW "propagates EngineError code as errorCode" — a handler throwing
   `new EngineError(EngineErrorCode.NOT_CONNECTED, ...)` yields `{ success: false, errorCode: "NOT_CONNECTED" }`.
   Must be RED before the fix (errorCode undefined) and GREEN after. Existing GraphicsError test stays green.
2. `engine-adapter.test.ts`: NEW "rethrows EngineError from adapter.runMacro unchanged" (RED before: plain Error),
   NEW "publishes engine_error with the adapter's EngineErrorCode" (RED before: literal "engine_error"),
   NEW "persists the config after a successful manual connect" and "does not persist when connect fails"
   (RED before: dep never called). Existing test around ~496-500 stays green via the `?? "engine_error"` fallback.
3. `engine-event-publisher.test.ts`: `engine_status` payload contains `errorCode` (null when unset).
4. `engine-connect-schema` test (create `engine-connect-schema.test.ts` if missing): "accepts an IPv4 with surrounding
   whitespace and returns it trimmed" (RED before).
5. `error-code.test.ts`: EngineError, GraphicsError, `{ code: "X" }`, plain Error (undefined), non-object (undefined).
6. `command-router.test.ts` no longer asserts persistence via the router; a service-level test covers it.
7. `npx jest apps/bridge/src/services/shared apps/bridge/src/services/engine apps/bridge/src/services/engine-adapter.test.ts
   apps/bridge/src/services/command-router.test.ts apps/bridge/src/routes --runInBand` green; then FULL
   `npm run test:jest` green; `npm run lint` clean; `npm run build:bridge` (tsc) clean.
8. No behaviour change for graphics, relay, meeting. Webapp contract only gains optional fields.
9. Docs: `docs/bridge/dataflows.md` (engine_error.code = EngineErrorCode; engine_status.errorCode) and
   `docs/bridge/reference/files/command-router.md` (errorCode propagation, persistence now in service) updated.

## Review
- Round: 1/3
- Verdict: PASS (note applied)
- Must-fix (open):
- Notes (non-blocking):
- Handoff to human (if any):

### Implementation notes
- Files changed: engine error-code helper/tests, engine adapter service/adapters, command router/tests, engine event publisher/tests, engine connect schema/test, websocket contract/test, bridge docs.
- Deviations: full `npm run test:jest` is not green in this sandbox due pre-existing `electron-renderer-client.test.ts` `listen EPERM 127.0.0.1` failures; verified on a temporary base-state run after reversing this worktree's changes.

## Verification
- [ ] Tests pass (targeted + full `npm run test:jest`)
- [x] Lint / type-check pass (`npm run lint`, `npm run build:bridge`)
- [x] Browser-verified (n/a — bridge only)
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
