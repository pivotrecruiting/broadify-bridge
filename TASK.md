# Task: Meeting multi-client sync — PR-B: typed meeting status, content_source, push-on-write, partial-status merge

## Raw request
Gabriel (2.10.2026): Meeting webapp on the bridge PC and a second webapp must stay in sync in both directions (control, setup, session). Plan approved: `~/.claude/plans/erstelle-einen-plan-um-floofy-conway.md`, Stage 2 / PR-B.

## Context
- Customer / project: Broadify Bridge, TS meeting services (`apps/bridge/src/services/meeting/*`).
- Worktree / branch: `broadify-bridge-worktrees/meeting-status-push-on-write` / `feature/meeting-status-push-on-write`
- Base branch: `dev` (14add97a)

## Plan
- New `meeting-status-types.ts` (`MeetingStatusT`, program summary, keyer settings, `content_source` two-slot shape, `camera_permission_status`).
- New `meeting-content-source-state.ts`: video/browser slots set by the content commands, reconciled against the meeting-back layer map at snapshot time; `url` published, never logged.
- `meeting-helper-manager.ts`: public coalesced `requestStatusPublish(reason)` (120 ms fixed window, forced, serialized), `notifyRecordingChanged` as alias; manager-held `cameraPermissionStatus` merged into `getFullStatus()`; the three partial `camera_permission_*` publishes routed through the full snapshot.
- `meeting-command-handler.ts`: request a publish after program update, keyer configure/reset, content video/browser set+clear, vcam start/stop/auto-arm, camera select/program-select/start/stop.
- `status-publish-policy.ts`: `updated_at` volatile.

## Acceptance criteria
1. Every `meeting_status` event is a full snapshot (camera-permission events included) — before-red test.
2. `meeting_program_update` and the other listed commands trigger a forced publish within ~120 ms; bursts coalesce into one publish with joined reasons — before-red test.
3. `content_source` reflects MP4/browser set/clear and drops a slot whose layer disappeared.
4. `getFullStatus()` always carries `content_source` and `camera_permission_status`.
5. `npm run lint`, jest for meeting/graphics/command-router, full `npm run test:jest`, `npm run build:bridge` green.

## Review
- Round: 1/3
- Verdict: PASS (2.10.2026, reviewer: Claude; verifier: separate agent, not the implementer)
- Must-fix (open): none
- Notes (non-blocking): `MeetingContentSourceState.snapshot()` calls the layer-presence probe without try/catch — `GraphicsManager.getStatus()` is synchronous and does not throw today; if that ever changes, treat a probe error as "present". Type-only import cycle meeting-status-types ↔ meeting-helper-manager (erased at runtime; could move `MeetingHelperManagerStatusT` later).
- Handoff to human (if any): merge to dev needs Gabriel's go; RC after PR-A/B/C.

## Verification
- [x] Tests pass — jest meeting 17 suites / 200 tests; graphics + command-router 60 suites / 828 tests; full `npm run test:jest` 200 suites / 2298 tests
- [x] Lint / type-check pass — `npm run lint`, `npm run build:bridge` (tsc)
- [ ] Browser-verified (n/a, bridge-side; field test with the RC)
- [x] Bug reproduced before the fix, gone after — verifier stashed only the two production files: "camera_permission_completed publishes a full snapshot" and "meeting_program_update requests a status publish" FAIL on old code for the right reason, PASS on new code
