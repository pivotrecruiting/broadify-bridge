# Task: WP3 — Windows GPU-resident meeting pipeline (Stufe B-1)

## Raw request
User Go 22.08.2026 ("Go fürs weiter bauen") after rc.21 (WP0+WP1+WP2) shipped. Stufe B = the architecture step that
brings Windows to "other apps" level. Design: `docs/bridge/architecture/meeting-windows-stage-b-design.md` (section 2).

## Context
- Worktree / branch: `broadify-bridge-worktrees/win-stability-wp3` / `feature/win-stability-wp3`, base `feature/win-stability-wp2`.
- Host macOS: Windows C++ (D3D11/D3D12/DirectML/MF) compiles only in CI. macOS untouched.
- Everything in this WP is behind `BROADIFY_MEETING_GPU_RESIDENT=1` (default OFF in this WP so rc.22 can be A/B-tested in the
  field; flipping the default is a later decision). With the flag off, the rc.21 pipeline must be byte-for-byte unchanged.
- Paths relative to `apps/bridge/native/meeting-helper/src/` unless noted.

## Plan (one commit per block)

### Block A — GpuContext (`compose/gpu_context_win.{h,cpp}`)
A1. One `IDXGIAdapter4` from the existing adapter policy (WP1 `d3d_adapter_select`), one `ID3D11Device5` + immediate context
    (`D3D11_CREATE_DEVICE_BGRA_SUPPORT`, feature level ≥ 11.0), one `ID3D12Device` + one DIRECT command queue on the same LUID.
    Reuse/replace the separate device creation in `d3d11_compositor.cpp` and `modnet_keyer.cpp` (DML1 path) so all three share
    the GpuContext when the flag is on; with the flag off the existing creation paths stay.
A2. Shared fence: `ID3D12Fence` created with `D3D12_FENCE_FLAG_SHARED`, `CreateSharedHandle`, opened in D3D11 via
    `ID3D11Device5::OpenSharedFence`. Helpers `signalFromD3D11(value)`, `waitOnD3D12(value)`, `signalFromD3D12`, `waitOnD3D11`
    (`ID3D11DeviceContext4::Signal/Wait`). No CPU waits in the steady state; a 3-deep frame ring (`FrameSlot{index, fenceValue}`).
A3. Unit-testable ring/fence bookkeeping (`compose/gpu_frame_ring.{h,cpp}`, platform-neutral) + ctest.

### Block B — Capture on the GPU (`capture/camera_mediafoundation.cpp`)
B1. When the flag is on: `IMFDXGIDeviceManager` (`MFCreateDXGIDeviceManager` + `ResetDevice` with the GpuContext D3D11 device),
    `MF_SOURCE_READER_D3D_MANAGER`, `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING`, `MF_LOW_LATENCY`. Request native NV12
    (preferred) or YUY2 as the reader output (no RGB32). Samples via `IMFDXGIBuffer::GetResource` → `ID3D11Texture2D` (+ subresource
    index). Hand the texture (and its timestamp) to the pipeline as a `GpuCameraFrame` (ComPtr + fence value), latest-slot semantics
    as today.
B2. Fallback: if the D3D manager path fails at open (driver without DXVA, MJPG-only device without HW decoder) log
    `camera_gpu_capture_unavailable` and fall back to the rc.21 RGB32 CPU path automatically (flag stays on for the other stages:
    the CPU frame is uploaded once into the GpuContext as today).
B3. Keep the WP0 error/reopen/watchdog behaviour identical on the GPU path.

### Block C — Preprocess compute shader (`compose/gpu_preprocess.{h,cpp}` + HLSL string)
C1. NV12 (two SRVs: R8 luma + R8G8 chroma) or YUY2 → letterboxed, box-downsampled, normalised ((v-0.5)/0.5) NCHW fp32 tensor
    written into an `ID3D11Buffer` (`D3D11_BIND_UNORDERED_ACCESS`, `D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED`)
    sized for the current tier (512/320/256). Reuse the WP2 letterbox mapping struct so the alpha crop is identical.
C2. One buffer per ring slot; shared handle opened in D3D12 (`ID3D12Device::OpenSharedHandle`) once per (slot, size).
C3. Unit test for the letterbox/tensor index math shared with the CPU path (the CPU reference from WP2 must produce the same
    mapping; a ctest compares the mapping tables).

### Block D — Inference with IO binding (`keyer/modnet_keyer.cpp`)
D1. When the flag is on: `OrtDmlApi::CreateGPUAllocationFromD3DResource` on the opened D3D12 input buffer → `Ort::Value` bound as
    input via `Ort::IoBinding`; output bound to an EP-allocated device tensor; after `Run`, `GetD3D12ResourceFromAllocation` gives
    the output resource, which is shared back to D3D11 (`CreateSharedHandle` on the D3D12 resource → `OpenSharedResource1`) as the
    alpha source buffer. Fence: D3D11 signals after preprocess, D3D12 queue waits; D3D12 signals after `Run`, D3D11 waits before
    the guided pass. `Run` stays on the program thread for the fused path (single caller per session).
D2. Sessions per tier (WP2 prebuilt) keep working; IO binding objects are per (tier, slot).
D3. Fallback: any failure in D1 (API missing, allocation failed) → log `keyer_gpu_binding_unavailable` once and use the rc.21 CPU
    tensor path for that session; status field `keyer_io_binding: true|false`.

### Block E — Refine + composite on the GPU (`compose/d3d11_compositor.cpp`)
E1. Guided filter consumes the alpha buffer directly (SRV over the shared buffer; convert to the existing R32F/R8 plane with one
    dispatch) — no CPU readback of the raw mask on the GPU path; coefficient EMA (WP2) unchanged.
E2. Compositor samples the camera NV12/YUY2 texture directly (YUV→RGB in-shader, studio range per MF attributes), the refined
    alpha, and the existing background/logo textures; writes (a) an NV12 output texture (luma + chroma passes) and (b) only when a
    CPU consumer exists (recorder, MJPEG preview, FrameBus, VCam-TCP until WP4) the RGBA staging readback via the existing ring
    (WP1, opt-in) or blocking Map.
E3. Camera-frame CPU consumers that still need RGBA while the flag is on (recorder, preview) get it from the compositor readback,
    never from a second conversion.

### Block F — Self-test, telemetry, docs
F1. `meeting-helper --gpu-selftest`: creates the GpuContext on WARP (`D3D_DRIVER_TYPE_WARP` / WARP adapter) when no HW adapter,
    runs preprocess → (DML if available, else skip) → composite on a synthetic NV12 frame, prints JSON `{ok, stages, ms}`; wired into
    the Windows release smoke (`scripts/*windows*smoke*` / `test-release.yml`) so CI executes the GPU path, not only compiles it.
F2. `keyer.get`/`state.get`: `gpu_resident: true|false`, `gpu_capture: dxgi|cpu`, `keyer_io_binding`, per-stage ms
    (`preprocess_ms`, `inference_ms`, `refine_ms`, `composite_ms`), `cpu_frame_copies_per_frame` (must be 0 with only a VCam consumer).
F3. Docs: `docs/bridge/features/meeting-windows-performance.md` (flag, A/B guide, fallbacks, telemetry) and the design doc's
    status section.

## Acceptance criteria
1. Flag off: no behavioural change (all existing ctests/jest unchanged; review confirms every new path is gated).
2. Flag on, steady state, VCam-only consumer: `cpu_frame_copies_per_frame == 0` (telemetry) — code review + selftest assertion.
3. GpuContext shares one LUID across D3D11, D3D12 and DML (telemetry fields equal); shared fence round-trip in the selftest.
4. GPU capture falls back to the CPU path on failure with a logged reason; WP0 reopen/watchdog behaviour unchanged (existing tests).
5. Letterbox/tensor mapping identical between CPU and GPU preprocess (ctest).
6. IO binding fallback to CPU tensors on failure (unit test of the decision logic; selftest path on WARP skips DML gracefully).
7. `--gpu-selftest` runs in the Windows CI smoke and passes on WARP.
8. lint / jest / build / macOS helper build / ctests green; Windows compile + selftest in CI.
9. Docs updated; comments in English; env flag documented.

## Review
- Round: 1/3
- Verdict: MUST-FIX (round 1) — substance: only Block A is a real data path; B is unsafe, C/D/E are stubs, F is tautological.
- Must-fix (open):
  - M1 `capture/camera_mediafoundation.cpp` ~:696-753: with the DXGI reader open (NV12/YUY2) the legacy BGRA swizzle reads
    `width*4` bytes per row from a 1.5/2 B-per-pixel buffer → heap over-read + garbage. On the GPU path do NOT run the CPU
    swizzle; deliver `GpuCameraFrame` downstream (M2). Request NV12 first, then YUY2 (never MJPG) from the D3D-manager reader.
  - M2 `GpuCameraFrame` must actually reach the pipeline: camera_source API → frame_pipeline → preprocess/compositor; report
    `gpu_capture:"dxgi"` when active; release the MF texture after consumption (do not starve the MF DXGI allocator).
  - M3 Thread-safety: the D3D11 immediate context is not thread-safe — never call `signalFromD3D11`/`frameRing().acquireNext()`
    from the MF callback thread; initialise `GpuContextWin` once on the main thread before capture starts; one mutex around all
    immediate-context use, or move capture-side fence work to the pipeline thread.
  - M4 `GpuContextWin::initialize()`: QI `ID3D10Multithread` and `SetMultithreadProtected(TRUE)` (required by the MF DXGI manager).
  - M5 `compose/gpu_preprocess.cpp`: (a) shared tensor buffer must be created on the D3D12 side (`CreateCommittedResource`,
    `D3D12_HEAP_FLAG_SHARED`, `ALLOW_UNORDERED_ACCESS`) → `ID3D12Device::CreateSharedHandle` → `ID3D11Device1::OpenSharedResource1`
    (D3D11 cannot share buffers); (b) create NV12 SRVs (`R8_UNORM` luma, `R8G8_UNORM` chroma, TEXTURE2DARRAY with
    `FirstArraySlice = subresource`) / YUY2 SRV and bind them; (c) implement the box-average in-shader over the same integer
    bounds as the CPU `buildModnetInputTensor` (criterion 5) and add a ctest comparing against the CPU reference on a synthetic
    frame; (d) add `using Microsoft::WRL::ComPtr;` (unqualified `ComPtr<ID3DBlob>`/`ComPtr<IDXGIResource1>` = MSVC error);
    (e) `preprocess()` must be CALLED from the fused path when the flag is on.
  - M6 `keyer/modnet_keyer.cpp`: implement real IO binding — per-(tier,slot) `Ort::IoBinding`, input from the shared D3D12 buffer via
    `OrtDmlApi::CreateGPUAllocationFromD3DResource`, output to EP device memory, `GetD3D12ResourceFromAllocation` shared back to
    D3D11 as the alpha source; `waitOnD3D12(slot.fence)` before `Run`, `signalFromD3D12` after; feed REAL booleans into
    `decideKeyerIoBinding`.
  - M7 `compose/d3d11_compositor.cpp`: E1 guided filter consumes the alpha buffer on the GPU (no CPU readback of the raw mask);
    E2 compositor samples NV12/YUY2 directly (YUV→RGB in-shader, studio range) and writes an NV12 output texture; E3 RGBA readback
    only when a CPU consumer exists (recorder/preview/FrameBus/VCam-TCP) — counted in `cpu_frame_copies_per_frame`.
  - M8 `--gpu-selftest` must execute preprocess (synthetic NV12) → (DML if available) → composite, and prove the fence with
    `SetEventOnCompletion` + bounded CPU wait; the ps1 asserts D3D11 LUID == D3D12 LUID; no literal constants in the JSON.
  - M9 Restore the WP1 content of `docs/bridge/features/meeting-windows-performance.md` (GPU policy values, QoS, gating, staging
    ring, governor latency policy, FUSED_PIPELINE_DEPTH) and add the WP3 section.
  - M10 Telemetry honesty: `preprocess_ms/inference_ms/refine_ms/composite_ms` measure the GPU stages when the flag is on (null
    otherwise); `gpu_resident` derived from `GpuContextWin::telemetry().available` only; `cpu_frame_copies_per_frame` counted from
    real copies (VCam-TCP counts 1 until WP4 — document).
- Notes: `<cstdio>` in gpu_context_win.cpp; `gpuCaptureActive_` reset on reopen; design doc says compute queue, impl uses DIRECT
  (align the doc to DIRECT per WP1); selftest JSON line filtering in the ps1.
- Decision (orchestrator): WP3 is NOT included in rc.22; it ships only after a real GPU path passes review.

## Verification
- [x] Focused CTests passed on macOS during implementation:
  `gpu_frame_ring_test`, `camera_gpu_capture_policy_test`,
  `gpu_preprocess_mapping_test`, `keyer_io_binding_policy_test`,
  `gpu_resident_consumer_policy_test`.
- [x] `npm run lint` passed.
- [x] `npm run test:jest` passed on sequential rerun: 173 suites / 1951 tests.
  First attempt was run concurrently with `npm run build` and hit unrelated
  temp-file ENOENT failures in asset/file log tests.
- [x] `npm run build` passed, including Jest, release-contract tests,
  protocol, bridge, graphics renderer and app build.
- [x] `npm run build:meeting-helper` passed on macOS.
- [x] `npm run test:meeting-helper-native` built all native test targets and
  ran CTest: 27/28 passed; the only failure was
  `meeting_recorder_writer_test failed: writer builds (audio_input_rejected)`,
  the known sandbox microphone issue.
- [ ] Windows CI compile + `meeting-helper --gpu-selftest` pending on the RC.
  macOS cannot compile or execute the D3D11/D3D12/DirectML/MediaFoundation code.
- Deviation: WP3 adds the guarded Windows GPU resources and fallback/telemetry
  scaffolding, but the current helper still exposes RGBA frames to existing CPU
  consumers. VCam-only `cpu_frame_copies_per_frame == 0` requires WP4's
  shared-memory NV12 VCam transport; TCP VCam is counted as a CPU consumer.
