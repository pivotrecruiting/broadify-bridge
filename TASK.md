# Task: Meeting screen sharing — PR3: Windows.Graphics.Capture backend (enumeration + capture by source id)

## Raw request
Gabriel (4.10.2026): screen sharing in Meeting Mode on macOS and Windows. Plan approved 4.10.2026: `~/.claude/plans/ich-gehe-davon-aus-woolly-toast.md`. Decision: Windows source list in the webapp (no thumbnails), capture by `source_id`; Windows test device available for the Stage-0 spike.

## Context
- Customer / project: Broadify Bridge meeting helper (`apps/bridge/native/meeting-helper`), Windows only.
- Worktree / branch: `broadify-bridge-worktrees/meeting-screenshare-windows` / `feature/meeting-screenshare-windows` (stacked on `feature/meeting-screenshare-helper`, PR1 commit 58e9ab14).
- Base branch: `dev` (after PR1 merges).
- Constraint: written on macOS; `screen_capture_wgc.cpp` is compile-verified only by CI (`windows-2022`) and the Windows test device.

## Plan
Plan file section "PR3" + "Stufe 0: Spike". Brief: scratchpad `codex/pr3-windows-wgc.md`.

## Acceptance criteria
1. `screen_capture_wgc.cpp` implements `ScreenCaptureSource` with EnumWindows/EnumDisplayMonitors enumeration (bridge/helper windows excluded), WGC capture via `CreateFreeThreaded` pool, cursor flag guarded by ApiInformation, `ContentSize` change → `Recreate`, `item.Closed` → stopped event, mip-level downscale policy for sources larger than the program size, BGRA→RGBA via `swizzleBgraToRgba`, `GuardedFrameSlot` publish.
2. macOS build + ctest stay green (CMake changes WIN32-scoped); any pure helper added (window-candidate filter, id formatting) is unit-tested in ctest.
3. Windows: `build.ps1` + ctest green on the test device / CI; Stage-0 go criteria met (≥ 25 fps 1080p share of a 1080p and a 4K display, CPU ≤ 20 % of a core for capture+convert, FrameArrived ≤ 8 ms, window close → stopped ≤ 2 s, no crash).
4. Docs: dev-setup "Bildschirmfreigabe (Windows)" section + README line; spike numbers into `docs/bridge/features/meeting-screen-sharing.md` (PR4).

## Review
- Round: 1/3
- Verdict: PASS round 1 on the macOS side (4.10.2026; reviewer: Claude; verifier: separate agent — build.sh exit 0, ctest 36/36, before-proof: 4 compile errors naming WindowCandidate/isShareableWindowCandidate → green after restore, CMake WIN32-scoped, static review a–l met). Windows compile + runtime: OPEN (CI windows-2022 / test device). Orchestrator applied the verifier's zero-risk hardening (`winrt::guid_of<GraphicsCaptureItem>()` instead of the ABI namespace).
- Must-fix (open): none. Windows prerequisites to verify: Windows SDK ≥ 10.0.19041 projection headers (`IsCursorCaptureEnabled`), `cppwinrt` include dir + `windowsapp.lib` in the build environment (first C++/WinRT use in the helper); CI runner windows-2022 ships a newer SDK.
- Notes (non-blocking):
  - Reviewer fixed the dev-setup doc example (`program.update` used an invented `patch` shape; now `section`/`values`).
  - Spike check: `onFrameArrived` holds the checked-out frame while calling `Recreate` on a size change (libobs does the same); if frames stall after a resize, close the frame before `Recreate`.
  - Event codes `screen_capture_start_failed` / `screen_capture_frame_failed` are helper event codes (RPC error code stays `screen_start_failed` per contract). Extra diagnostic events `screen_capture_metrics`, `screen_capture_close_error`, `screen_capture_winrt_apartment` are not in the bridge's forced-publish set (intended).
  - `winrtDevice_` is dropped on stop, so the D3D11 device is recreated on the next start (cheap; acceptable).
- Handoff to human (if any): Windows runtime verification needs the Windows device; merge only after explicit chat go.

## Verification
- [x] macOS build + ctest 36/36 green (verifier 4.10.)
- [ ] Windows build (build.ps1) + ctest green (device/CI)
- [ ] Spike go/no-go table with measured numbers (Windows device)
- [ ] Manual: list → start → share visible in MJPEG preview/VCam; window close → stopped + toast
