# Task: Accept displayModeId 0 for display targets and report readable output-config validation errors (PR D1)

## Raw request
Field report 25.9.2026 (Gabriel, RC v0.27.2-rc.1 + webapp dev): configuring the HDMI output ("video_hdmi") for a Blackmagic
display fails with the raw Zod issue list
`[{"code":"too_small","minimum":0,"type":"number","inclusive":false,"exact":false,"message":"Number must be greater than 0","path":["format","displayModeId"]}]`.
Root cause (verified): `GraphicsFormatSchema.displayModeId` is `z.number().int().positive().optional()`
(`apps/bridge/src/services/graphics/schemas/output-schemas.ts:28`, PR #209). The display module enumerates HDMI/DP modes with
list indices starting at 0 (`apps/bridge/src/modules/display/display-module-utils.ts` — `modes.map((mode, id) => …)`), and the
webapp (dev) now sends `format.displayModeId = mode.id` for every port once the bridge reports >= 0.27.2. The first (native)
display mode therefore has id 0 and is rejected by the schema before `validateOutputFormat` runs; modes with index > 0 pass
because the validation service only checks `displayModeId` for DeckLink devices (`graphics-output-validation-service.ts:235-258`).
Second defect: `GraphicsManager.configureOutputs` (`graphics-manager.ts:~359`) uses `.parse()` and forwards the ZodError's
message (the JSON issue array) verbatim as the `output_config_error` text shown to the user.

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/hdmi-display-mode-id / feature/hdmi-display-mode-id
- Base: dev 54df1113 (0.27.2-rc.1). Target dev. Prod webapp (main) never sends `displayModeId`; only dev webapp + bridge >= 0.27.2 hit this.
- Semantics to keep: `displayModeId` is a DeckLink SDK display mode id (BMDDisplayMode, never 0) and is ignored for display
  targets. The DeckLink adapters already skip falsy ids (`if (config.format.displayModeId)`), the validation service already
  returns before the id check for non-DeckLink devices. The persisted output config reuses `GraphicsConfigureOutputsSchema`
  (`output-config-store.ts:123`), so the schema change also makes persisted display configs with id 0 loadable.
- Existing ZodError handling pattern: `apps/bridge/src/routes/engine.ts:100-114` (duck-typed `error.name === "ZodError"`,
  `zodError.errors.map(e => ({ path: e.path.join("."), message: e.message }))`). Reuse the idea in a shared helper; do NOT
  refactor the routes in this PR.
- Conventions: kebab-case files, English comments/JSDoc, Jest ESM (`npx jest <path> --runInBand`), no new dependencies.
  Docs under `docs/bridge/*` must be updated in the same PR.

## Plan
1. `apps/bridge/src/services/graphics/schemas/output-schemas.ts`: `displayModeId: z.number().int().nonnegative().optional()`
   with a JSDoc line: DeckLink SDK mode id (> 0); display targets enumerate modes by list index from 0 and ignore the field,
   so 0 must be accepted.
2. NEW `apps/bridge/src/services/shared/zod-error-message.ts`: `isZodError(error: unknown): error is ZodError` (duck-typed by
   `name`, same as routes/engine.ts) and `formatZodError(error: ZodError, prefix: string): string` →
   `"<prefix>: <path>: <message>"` joined with `"; "` for several issues (path via `issue.path.join(".")`, empty path → `"payload"`).
3. `apps/bridge/src/services/graphics/graphics-manager.ts` `configureOutputs`: `safeParse`; on failure
   `this.failGraphics("output_config_error", formatZodError(result.error, "Invalid output configuration"))`. Keep the
   non-Zod error path unchanged.
4. Docs: `docs/bridge/features/output-config.md` (~52) and `docs/bridge/features/graphics-commands.md` (~67): one sentence each —
   display targets carry list indices starting at 0, the bridge accepts and ignores them; invalid payloads now yield a readable
   `output_config_error` text.

## Acceptance criteria (RED before unless marked guard)
1. `output-schemas.test.ts`: "accepts displayModeId 0 (display targets enumerate modes from index 0)" — RED before.
   Keep "rejects a non-integer displayModeId"; add "rejects a negative displayModeId".
2. `shared/zod-error-message.test.ts`: formats a single issue, joins several issues, uses "payload" for an empty path,
   `isZodError` accepts a real ZodError and rejects a plain Error.
3. `graphics-manager.test.ts`: "fails configureOutputs with a readable output_config_error for an invalid payload" — asserts the
   message contains `format.displayModeId` and does NOT start with `[` — RED before (today the message is the JSON array).
4. `graphics-output-validation-service.test.ts`: "ignores displayModeId for display devices" (guard; add only if not covered).
5. `npx jest apps/bridge/src/services/graphics apps/bridge/src/services/shared --runInBand` green; `npm run lint`;
   `npm run build:bridge`. FULL `npm run test:jest` is run by the verifier (outside the Codex sandbox).

## Review
- Round: 1/3
- Verdict: PASS (Claude review 25.9.: schema semantics preserved, safeParse path keeps failGraphics contract, helper mirrors routes/engine.ts pattern)
- Must-fix (open): none
- Notes (non-blocking): `isZodError` has no caller yet (kept for the routes cleanup that should reuse the helper later).
- Handoff to human (if any):

### Implementation notes

- Changed `apps/bridge/src/services/graphics/schemas/output-schemas.ts` to accept nonnegative `displayModeId` and documented why display mode index `0` is valid for display targets.
- Added `apps/bridge/src/services/shared/zod-error-message.ts` and tests for readable Zod validation messages.
- Changed `apps/bridge/src/services/graphics/graphics-manager.ts` `configureOutputs` schema handling to use `safeParse` and emit readable `output_config_error` messages.
- Added RED/green schema and manager tests, shared formatter tests, and a guard test that display devices ignore `displayModeId`.
- Updated `docs/bridge/features/output-config.md` and `docs/bridge/features/graphics-commands.md` with display-target index and readable error behavior.
- Deviation: the required services Jest command is blocked in this sandbox by `listen EPERM: operation not permitted 127.0.0.1` in `apps/bridge/src/services/graphics/renderer/electron-renderer-client.test.ts`; focused tests for the changed behavior pass.

## Verification
- [ ] Tests pass (targeted + full)
- [x] Lint / type-check pass
- [x] Bug reproduced before the fix (RED test runs recorded in the report), gone after
- [x] Docs updated
