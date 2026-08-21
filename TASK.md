# Task: WP1 — Windows meeting load & latency (Stufe A)

## Raw request
User Go 21.08.2026: implement both stages (A: Stellschrauben, B: Umbau) after the Windows deep analysis.
WP1 = Stufe A for symptoms 1 ("laptop gets loud with VCam") and 2 ("latency").

## Context
- Worktree / branch: `broadify-bridge-worktrees/win-stability-wp1` / `feature/win-stability-wp1`
- Base branch: `feature/win-stability-wp0` (stacked on WP0, which is stacked on `feature/vcam-rc10`).
- Host macOS; Windows C++ compiles only in CI. Keep macOS build + ctest green.
- Evidence: analysis report sections 01/02 (https://claude.ai/code/artifact/da4506cb-1180-4e8c-9798-5ac541a10202).
  Paths relative to `apps/bridge/native/meeting-helper/src/` unless noted.

## Plan (each block = one commit)

### Block A — One GPU adapter, one upload, no blocking readback (`compose/d3d11_compositor.cpp`, `keyer/modnet_keyer.cpp`)
A1. Adapter policy: a small platform helper (`compose/d3d_adapter_select.{h,cpp}`, Windows-only) enumerates via
    `IDXGIFactory6::EnumAdapterByGpuPreference`. Policy env `BROADIFY_MEETING_GPU_POLICY` = `auto|high_performance|minimum_power`
    (default `auto` = high_performance when a discrete adapter exists, else the only adapter). The chosen adapter LUID is
    used BOTH for `D3D11CreateDevice` (compositor + guided filter) and for DirectML (create the D3D12 device on that
    adapter and use `SessionOptionsAppendExecutionProvider_DML1` with our own device + queue; keep `DML2` as fallback).
    Log the adapter description + LUID once (`gpu_adapter_selected` helper event) for both devices; status `keyer.get`
    reports `gpu_adapter` and `compositor_adapter`.
A2. Upload the camera frame once per frame into one texture shared by the guided-filter pass and the compositor pass
    (drop the second `UpdateSubresource`); cache by frame timestamp.
A3. Staging ring (3 deep) for both readbacks: issue `CopyResource` for frame N, `Map` the staging of frame N-1 with
    `D3D11_MAP_FLAG_DO_NOT_WAIT` (fall back to a blocking Map only if N-2 is also not ready). The program frame therefore
    lags the GPU by one frame but never stalls the CPU. Same for the guided-filter mask readback.
A4. Fold the guided-filter dispatch chain and the compositor into one command submission per frame (no intermediate
    readback of the refined mask when the GPU compositor consumes it directly — keep the mask on the GPU; only read it
    back when a CPU consumer (recorder/preview post-process) needs it).
    Deferred to WP3.

### Block B — Consumer-gated work (`pipeline/frame_pipeline.cpp`, `state/meeting_state.h`)
B1. Fused keyer + guided + compositor + readback run only when `hasNewCameraFrame` (or a program/graphics revision
    changed). Cadence counter increments only on new camera frames.
B2. FrameBus write only when a FrameBus reader is attached or `framebusRunning` was explicitly requested by an RPC
    (`framebusRunning` default → `false`; `conference_display_start` already starts it). Keep the 1 Hz heartbeat for
    attached readers only. Explicit-start RPC semantics beyond `conference_display_start` are deferred to WP3.
B3. Preview publish only when `previewClients > 0 || vcamClients > 0` (already) — additionally skip the MJPEG encode
    when no MJPEG client is connected (verify) and lower MJPEG to 10 fps while a VCam client is active.

### Block C — Threads, timers, QoS (`main.cpp`, `pipeline/frame_pipeline.cpp`, `preview/raw_frame_server.cpp`)
C1. Windows: `timeBeginPeriod(1)` while the pipeline is in `live`/`keyer_live` (`timeEndPeriod` otherwise);
    `SetProcessInformation(ProcessPowerThrottling)` opting OUT of `EXECUTION_SPEED` throttling and of
    `IGNORE_TIMER_RESOLUTION`; `AvSetMmThreadCharacteristicsW(L"Capture")` on the program thread and the raw-frame
    sender threads; `AvRevertMmThreadCharacteristics` on exit. Env kill-switch `BROADIFY_MEETING_WIN_QOS=0`.
C2. Program loop wakes on camera-frame arrival (condition variable signalled from the MF callback) with the 33 ms grid
    as the upper bound — not a fixed `sleep_until` grid. Overrun policy: skip to the newest frame, never run
    back-to-back more than one catch-up tick.
C3. Raw-frame server: replace the 16 ms poll with a condition variable signalled from `PreviewFrameStore::publish`.
C4. Raw-frame sender sockets: `TCP_NODELAY`, `SO_SNDBUF` ≥ 2 frames.

### Block D — Copies and conversions
D1. SIMD swizzles (SSE2 baseline, AVX2 dispatch when available) for BGRA↔RGBA on Windows in capture, raw-frame
    server and recorder (`util/pixel_swizzle.{h,cpp}` + ctest comparing against the scalar reference).
D2. Capture: reuse a pooled frame buffer instead of a fresh `std::vector` per sample; `copyLatestFrameIfNew` hands out a
    shared immutable buffer (no 8 MB copy on the program thread). Deferred to WP3.
D3. Request the camera's native media type explicitly: prefer the 30 fps type at ≤1920x1080 whose subtype is NV12/YUY2/
    MJPG (in that order) and use `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING` + `MF_LOW_LATENCY` so the conversion
    to RGB32 is done by the video processor MFT (GPU when available) instead of the basic software converter.
    Log the negotiated native type and fps (`camera_media_type` event). Partially addressed in WP1; native subtype
    preference/conversion verification is deferred to WP3.
D4. ORT session options for DML: `SetIntraOpNumThreads(1)`, `AddConfigEntry("session.intra_op.allow_spinning","0")`,
    `DisableMemPattern`, `ORT_SEQUENTIAL` (verify present), free-dimension overrides for fixed input size per tier.

### Block E — Latency policy
E1. Governor step-down threshold 0.5 × budget (16.7 ms at 30 fps) with the existing hysteresis; step-up unchanged.
E2. One-frame software pipeline: inference for frame N runs while frame N-1 is composited (the fused path keeps
    mask_age ≤ 1 frame instead of 0). Env `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0|1` (default 1).
    Deferred to WP3; WP1 only uses the env as a fused cadence reuse kill-switch.
E3. VCam DLL: `SetSampleTime` from the producer's capture timestamp (carried in the BFRG record: add a 64-bit
    capture_ns field → header version 2, client accepts v1 and v2) converted to QPC/MF time base; duplicate frames
    (same sequence) are re-delivered with the previous timestamp + frame duration.

### Block F — Docs
F1. `docs/bridge/features/virtual-camera-windows.md` + a new `docs/bridge/features/meeting-windows-performance.md`
    (adapter policy, QoS, env flags, measuring guide: Task Manager GPU 0/1, `keyer.get` fields).

## Acceptance criteria
1. Exactly one D3D adapter LUID is used by compositor and DirectML (status fields equal; helper event logged).
2. Camera frame uploaded once per frame (code review; counter in debug metrics).
3. No blocking `Map` in the steady state (ctest on the macOS build is not possible for D3D11 — review + Windows CI
   compile; add a platform-neutral ring-buffer unit test for the staging index logic).
4. `framebusRunning` defaults to false; FrameBus bytes are written only with a reader/explicit start (ctest on the
   pipeline gating logic or a control-server test).
5. Fused work does not run on reused camera frames (unit test of the gating predicate).
6. Windows QoS calls present and env-gated (review + CI compile).
7. SIMD swizzle ctest passes against the scalar reference for all alignments/tails.
8. ORT session options verified by a ctest that inspects the options builder (factor the builder into a testable
   function).
9. Governor threshold test updated (keyer_governor_test).
10. BFRG v2 header round-trip ctest (writer/reader) and the DLL accepts v1 and v2.
11. `npm run lint`, `npm run test:jest`, `npm run build`, `npm run build:meeting-helper`, `npm run test:meeting-helper-native` pass.
12. Docs updated; comments in English.

## Review
- Round: 1/3
- Verdict: MUST-FIX (round 1)
- Must-fix (open):
  - M1 `src/util/win_qos.cpp`: include `<windows.h>` BEFORE `<avrt.h>`/`<timeapi.h>` (avrt.h needs HANDLE/DWORD/WINAPI) — Windows compile error.
  - M2 `src/compose/staging_readback_ring.h` + `d3d11_compositor.cpp` `mapReadbackRing`: never map a slot that has not received a
    `CopyResource` (frame 0 after every `reset()` currently maps an unwritten buffer → garbage program frame / all-zero mask). Track
    written slots (`preferredValid = frameIndex_ >= 1` or a per-slot written flag); when not valid, do a blocking Map on the slot just
    copied. Fix the ctest to assert the invariant "never map an unwritten slot" instead of codifying the bug.
  - M3 `frame_pipeline.cpp` ~:2853-2879: after an early CV wake (camera frame before the deadline) set `nextFrameAt = now` (or clamp
    `nextFrameAt = min(nextFrameAt, now + frameInterval)` at the top of each iteration) so `nextFrameAt` cannot drift ahead with a
    60 fps camera; remove the dead overrun block inside `if (nextFrameAt > now)`. Windows-only path; macOS timing unchanged.
  - M4 `modnet_keyer.cpp` ~:495-512: apply `SetIntraOpNumThreads(1)` + `allow_spinning=0` ONLY after a DML append succeeded
    (`provider == "directml"`); CPU provider keeps `inferenceThreadCount()`.
  - M5 `vcam-helper/windows/media_stream.cpp` ~:294-352: clamp `sampleTime = max(sampleTime, _lastSampleTime + 1)` whenever a last
    good frame exists so sample times are strictly monotonic (duplicates at consumer rate, rebase after helper restart).
  - M6 A2 was NOT implemented (still two camera uploads: `ctx.camera` and the guided `guide` texture): upload the camera frame once per
    frame into one texture used by both passes (cache by frame timestamp) and add an upload counter to the debug metrics.
  - M7 Windows test-target link libs in CMakeLists: `d3d_adapter_select_test` needs `dxgi`; `raw_frame_server_test` (now compiles
    win_qos.cpp) needs `avrt winmm`. Also make `DMLCreateDevice` resolution robust: `GetProcAddress(LoadLibraryW(L"DirectML.dll"),
    "DMLCreateDevice")` instead of a static import of DirectML.lib (not vendored; CI link unproven) — fall back to DML2 when absent.
  - M8 TASK.md/docs honesty: record A4, B2(explicit start), D2, D3(partial), E2 as explicit deferrals to WP3 in the Plan, and correct
    `docs/bridge/features/meeting-windows-performance.md` so it describes what `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH` really does today.
- Notes (non-blocking): removed `(live && graphicsOutputActive)` render trigger means time-based backgrounds only advance on
  camera/program changes — add one sentence to the docs; `pixel_swizzle_test` is scalar-vs-scalar on macOS (SIMD proven only on a
  Windows ctest run); `d3d_adapter_select_test` covers env parsing only.
- Handoff to human (if any): Windows compile/link only in CI (RC push allowed).

## Verification
- [ ] Tests pass — `npm run test:jest` passed (173 suites / 1950 tests); `npm run test:meeting-helper-native` failed only `meeting_recorder_writer_test` with pre-existing macOS `audio_input_rejected` while 18/19 ctests passed.
- [x] Lint / type-check pass — `npm run lint`, `npm run build`, and `npm run build:meeting-helper` exit 0.
- [ ] Windows CI compile on the RC — not run from macOS worktree.
