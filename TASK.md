# Task: Meeting screen sharing — PR1: helper abstraction, stub, state/RPC, pipeline + compositor integration

## Raw request
Gabriel (4.10.2026): "Wie bekommen wir Screensharing im Meeting Mode auf Windows und Mac hin? Also dass im Content-Fenster der Screen geshared werden kann?" → research done, plan approved 4.10.2026: `~/.claude/plans/ich-gehe-davon-aus-woolly-toast.md` (Weg A: native capture in the meeting helper feeding the existing `media_layer` with `source: "screen"`). Decisions: macOS 14+ only (system picker, no TCC), spike before platform backends, Windows source list in the webapp without thumbnails.

## Context
- Customer / project: Broadify Bridge, meeting helper (`apps/bridge/native/meeting-helper`).
- Worktree / branch: `broadify-bridge-worktrees/meeting-screenshare-helper` / `feature/meeting-screenshare-helper`
- Base branch: `dev` (origin/dev @ 973ab212, 0.27.3-rc.4).
- Scope of this PR: NO platform capture backend. Introduces the `ScreenCaptureSource` abstraction + stub, `media_layer.source`, `screen.*` control RPCs, `state.get.screen_capture`, pipeline trigger + compositor live-frame path (GPU + CPU), Metal upload overload, tests. Behaviour for page media must stay pixel-identical.

## Plan
See plan file section "PR1". Contract (names, JSON keys, error codes) is the plan's "Kontrakt" section and is binding.

## Acceptance criteria
1. `npm run test:meeting-helper-native` green on macOS (ctest incl. new `screen_capture_source_test`, `guarded_frame_slot_test`, extended `frame_pipeline_gating_test`, extended `control_server_test`).
2. `program.update media_layer` with `source:"screen"` / without `source` / with `source:"bogus"` round-trips as `screen` / `page` / `page` in `state.get` program summary.
3. `screen.list|start|stop|pick` exist; with the stub they answer per contract (`screen_capture_unsupported` with `unsupported_os`, `screen.stop` idempotent ok).
4. `state.get` contains the `screen_capture` block per contract (`captured_frames` the only volatile counter).
5. Page media rendering unchanged (GPU on, `BROADIFY_MEETING_GPU_COMPOSITOR=0`, and D3D11 off on Windows) — manual MJPEG check by the verifier.
6. Helper builds via `bash apps/bridge/native/meeting-helper/build.sh` on macOS; Windows build only verified by CI/Windows device later (stub compiles on all platforms in this PR).
7. No Info.plist / entitlement changes; `scripts/verify-macos-release-signing.sh` unaffected.

## Review
- Round: 1/3
- Verdict: PASS round 1 (4.10.2026, reviewer: Claude; verifier: separate agent). Verifier: build.sh exit 0; ctest 36/36; before-proof = configure fails without src (missing screen_capture_source.cpp); control-socket live check of screen.list/pick/stop/start, program.update source round-trip, state.get block order; static checks OK.
- Must-fix (open): none.
- Notes (non-blocking):
  - Reviewer reverted three sandbox-only deviations the implementer made (Codex ran under a seatbelt sandbox): `build.sh` `|| true` after `security find-identity`, EPERM-skip in `raw_frame_server_test.cpp`, `audio_input_rejected`-skip in `meeting_recorder_writer_test.mm`. Verifier runs outside the sandbox; these tests must pass unchanged.
  - `control_server_test.cpp` gained a socket-or-direct RPC mode (`canBindControlEndpoint`); outside sandboxes the socket path runs as before. This required exporting `handleRpc` in `control_server.h` (moved out of the anonymous namespace). Accepted as harmless; documented here.
  - Stub reports `unsupported_os` on every platform until PR2/PR3 land (by design for PR1).
- Handoff to human (if any): merge only after explicit chat go.

## Verification
- [x] Tests pass (ctest 36/36 via build.sh + ctest, verifier run 4.10.)
- [x] Helper build passes (verifier run 4.10.)
- [ ] Manual MJPEG check: page media unchanged, screen source = layer absent with stub
- [x] Before/after: configure fails without the production sources (verifier run 4.10.)
