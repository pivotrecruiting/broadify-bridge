# Task: Meeting screen sharing — PR2: macOS ScreenCaptureKit backend (system picker, macOS 14+)

## Raw request
Gabriel (4.10.2026): screen sharing in Meeting Mode on macOS and Windows. Plan approved 4.10.2026: `~/.claude/plans/ich-gehe-davon-aus-woolly-toast.md`. Decision: macOS 14+ only via `SCContentSharingPicker` (no Screen-Recording TCC); macOS 13 reports `unsupported_os`. Stage-0 spike runs on this branch before the PR is finalised.

## Context
- Customer / project: Broadify Bridge meeting helper (`apps/bridge/native/meeting-helper`).
- Worktree / branch: `broadify-bridge-worktrees/meeting-screenshare-macos` / `feature/meeting-screenshare-macos` (stacked on `feature/meeting-screenshare-helper`, PR1 commit 58e9ab14).
- Base branch: `dev` (after PR1 merges).

## Plan
Plan file section "PR2" + "Stufe 0: Spike". Brief: scratchpad `codex/pr2-macos-sck.md`.

## Acceptance criteria
1. `screen_capture_sck.mm` implements `ScreenCaptureSource` with the system picker; `capabilities()` = supported/system_picker on macOS 14+, `unsupported_os` on 13; no TCC prompt on the picker path.
2. Stage-0 go criteria met on this Mac (1080p program, fullscreen share of a 1080p and a 4K/Retina display, 60 s): ≥ 25 rendered fps, helper CPU delta ≤ 20 % of one core, sample handler ≤ 8 ms/frame, window close → `screen_capture_stopped` ≤ 2 s without crash, `control.shutdown` leaves no OS "sharing" indicator.
3. VERIFY items closed with evidence: picker presents from the LSUIElement helper; `nm -m` weak-import of `SCContentSharingPicker`; `excludedBundleIDs` semantics; `contentRect`/`pointPixelScale` populated; `tccutil reset ScreenCapture` → no prompt; `SCFrameStatusStarted` handling.
4. `build.sh` signs (no entitlement/plist change); `npm run test:meeting-helper-native` green; `scripts/verify-macos-release-signing.sh` unaffected.
5. Docs: `meeting-helper-dev-setup.md` section + helper README line; spike numbers recorded in `docs/bridge/features/meeting-screen-sharing.md` (PR4 creates that doc; add the numbers there once both exist).

## Review
- Round: 1/3
- Verdict: PASS round 1 (4.10.2026; reviewer: Claude; verifier: separate agent — build.sh exit 0 with Developer ID signing, ctest 36/36 full suite, nm: picker classes weak-imported, control-socket contract live, static review a–k met). Spike (Stage 0) still open: needs the picker selection on this Mac.
- Must-fix (open): none.
- Notes (non-blocking):
  - Orchestrator fixed one line after review: `screen_capture_picker` emitted `code` as a bare JSON number; now a quoted string like `screen_capture_stopped` (contract: `code?` string).
  - Frames without a status attachment are processed (lenient fallback; SCK always attaches a status in practice).
  - `handleStreamStopped` nils the stream without `removeStreamOutput` (harmless on a stopped stream).
  - `verify-macos-release-signing.sh` needs a full `dist/` (electron-builder output) → BLOCKED locally; equivalent codesign/entitlement checks on the helper bundle passed.
- Handoff to human (if any): merge only after explicit chat go.

## Verification
- [ ] Tests pass (ctest full suite, outside the Codex sandbox)
- [ ] Helper build + signing pass
- [ ] Spike go/no-go table filled with measured numbers
- [ ] Manual: picker → share visible in MJPEG preview and VCam; stop → indicator gone
