# Task: Meeting multi-client sync — PR-A: native program summary geometry + background identity

## Raw request
Gabriel (2.10.2026): Meeting webapp on the bridge PC and a second webapp must stay in sync in both directions (control, setup, session). Plan approved: `~/.claude/plans/erstelle-einen-plan-um-floofy-conway.md`, Stage 2 / PR-A.

## Context
- Customer / project: Broadify Bridge, native meeting helper (control_server.cpp, meeting_state.h).
- Worktree / branch: `broadify-bridge-worktrees/meeting-status-summary-geometry` / `feature/meeting-status-summary-geometry`
- Base branch: `dev` (14add97a)

## Plan
- Struct fields `MediaLayerState.templateId`, `CornerbugState.logoAssetId`, `MeetingState.backgroundAssetId/backgroundTemplateId` parsed once in `updateProgramSection` / `keyer.configure`.
- `programSummaryJson`: `media_layer` += `template_id, x, y, width, height, rotation, rotation_x, rotation_y`; `cornerbug` += `x, y, size, logo_asset_id`; `jsonNumber()` guard for non-finite values. Never image data, image URLs or rendered paths.
- `keyer.get` settings += `background_asset_id`, `background_template_id`, `background_image_set`; `keyer.reset` clears the ids; `keyerConfigSignature` unchanged (documented).
- TS keyer schema += `background_asset_id` (nullable, optional, `.strip()` kept).

## Acceptance criteria
1. Summary carries the new geometry/identity fields; still no `image_data_url` / `image_url` / `rendered_page_path` / base64 (existing assertions keep passing).
2. `keyer.get` echoes the background ids and `background_image_set`, never the absolute path; `null` clears, absent keeps; reset clears both.
3. Changing only the ids does not trigger a keyer signature reset.
4. Non-finite numbers serialize as `0` (valid JSON).
5. `npm run build:meeting-helper && npm run test:meeting-helper-native` green (macOS), `npm run lint`, bridge jest for meeting services, `npm run build:bridge` green.

## Review
- Round: 1/3
- Verdict: PASS (2.10.2026, reviewer: Claude; verifier: separate agent, not the implementer)
- Must-fix (open): none
- Notes (non-blocking): `CornerbugState.hasImage` cache added by the implementer (no other writers of `cornerbug.rawJson`, consistent); Windows build not compiled locally (CI release build covers it).
- Handoff to human (if any): merge to dev needs Gabriel's go; RC after PR-A/B/C.

## Verification
- [x] Tests pass — ctest 34/34 (control_server_test incl. new assertions), jest meeting 16 suites / 185 tests
- [x] Lint / type-check pass — `npm run lint`, `npm run build:bridge` (tsc)
- [ ] Browser-verified (n/a, bridge-side contract; field test with the RC)
- [x] Bug reproduced before the fix, gone after — new keys absent on old code (inferred from diff; implementer could not run ctest inside its sandbox, verifier ran it outside: green)
