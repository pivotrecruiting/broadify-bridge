# Design: Windows Meeting Engine, Stufe B (GPU-resident pipeline, shared-memory VCam, temporal matting)

Status: WP3 implementation draft, 22.08.2026. Targets `apps/bridge/native/meeting-helper` (Windows paths) and
`apps/bridge/native/vcam-helper/windows`. macOS paths are untouched. All official references are in the
analysis report (section 06).

WP3 note: `BROADIFY_MEETING_GPU_RESIDENT=1` is still default-off. The helper now
has the shared D3D11/D3D12 context/fence, DXGI camera-open path with CPU
fallback, preprocess mapping/resources, IO-binding fallback telemetry, and
Windows release smoke self-test. Full end-to-end zero-copy VCam output remains
blocked on WP4's shared-memory NV12 virtual-camera transport.

## 1. Goals / non-goals
- Goal: zero CPU round-trips per frame between capture, keyer, compositor and the virtual camera on Windows.
- Goal: one GPU adapter per session; the Frame Server media source receives frames without TCP.
- Goal: temporal segmentation tiers by hardware class; no governor tier that shows the raw camera.
- Non-goal: changing the control plane (JSON-RPC, bridge, webapp), FrameBus for Graphics, macOS.

## 2. WP3 — GPU-resident pipeline
### 2.1 Devices
- `GpuContext` (new, `compose/gpu_context_win.{h,cpp}`): one `IDXGIAdapter4` chosen by policy (WP1 A1), one
  `ID3D11Device5` + immediate context (capture conversion, compositor, guided filter) and one `ID3D12Device` +
  compute queue (DirectML via `SessionOptionsAppendExecutionProvider_DML1`). Both from the same LUID.
- Sync: one shared `ID3D12Fence` (`CreateSharedHandle`) opened in D3D11 via `ID3D11Device5::OpenSharedFence`.
  D3D11 signals after preprocessing, D3D12 waits; D3D12 signals after inference, D3D11 waits. No CPU waits in the
  steady state; a 3-deep frame ring keeps producer/consumer one frame apart.

### 2.2 Capture
- Source Reader with `MF_SOURCE_READER_D3D_MANAGER` (IMFDXGIDeviceManager on the D3D11 device),
  `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING`, `MF_LOW_LATENCY`, async callback. Request the native type
  (NV12 preferred, then YUY2, then MJPG decoded by the HW MFT). Samples arrive as DXGI surfaces
  (`IMFDXGIBuffer::GetResource`); no system-memory copy.
- Fallback when the D3D manager path fails (driver without DXVA): today's RGB32 CPU path (kept, env-selectable).

### 2.3 Preprocess (compute shader, D3D11)
- NV12/YUY2 → letterboxed, box-downsampled, normalised float tensor (NCHW, fp16 when the DML device supports it)
  written into a `ID3D11Buffer` created with `D3D11_RESOURCE_MISC_SHARED_NTHANDLE`, opened in D3D12 and bound with
  `OrtDmlApi::CreateGPUAllocationFromD3DResource` (IO binding). One buffer per ring slot.
- Tensor shape fixed per tier (free-dimension overrides) → DML can pre-compile.

### 2.4 Inference
- `OrtIoBinding`: input = shared buffer, output = D3D12 buffer owned by ORT (`GetD3D12ResourceFromAllocation`),
  shared back to D3D11 as the alpha texture source. `Run` is called from a dedicated keyer thread (DML requires a
  single caller per session), synchronised with the ring via the shared fence.
- Sessions per tier pre-built (WP2 B1). Session options: DisableMemPattern, ORT_SEQUENTIAL, intra-op 1, no spinning.

### 2.5 Refine + composite (D3D11)
- Guided filter (existing D3D11 chain) consumes the alpha buffer directly; coefficient EMA (WP2 C4).
- Compositor samples the camera NV12 texture (YUV→RGB in-shader), the refined alpha, background/logo textures, and
  writes TWO outputs: an NV12 texture (for the VCam) and, only when a CPU consumer exists (recorder, MJPEG preview,
  FrameBus), an RGBA staging readback via the ring (never blocking).

### 2.6 Result
Per frame on the CPU: zero full-frame copies in the steady state with only the VCam consuming. Preview/recorder
add one readback each.

## 3. WP4 — Virtual camera transport
### 3.1 Shared memory ring
- Helper creates `Global\BroadifyVcam-<pid>-<token>` file mapping (and the same-named `Global\` event), ACL granting
  `GENERIC_READ|SYNCHRONIZE` to `NT AUTHORITY\LOCAL SERVICE` and full access to the owner. Layout: header
  (magic, version, width, height, fps, format = NV12, slot count = 3, slot stride) + slots, each with a sequence,
  QPC capture timestamp and the NV12 plane data. Writer: seqlock per slot (odd while writing).
- The mapping name is published to the DLL via a registry value under
  `HKLM\Software\Broadify\VirtualCamera\Stream` (written by the helper, read-only for LOCAL SERVICE) — the DLL runs
  in Session 0 without our environment, so the registry is the documented discovery primitive. Fallback: the
  existing TCP stream (kept for one release, env `BROADIFY_MEETING_VCAM_TRANSPORT=shm|tcp`).
- Option evaluated and deferred: shared DXGI surface (`CreateSharedHandle` with SD). Needs the Frame Server's
  D3D manager (`IMFMediaSourceEx::SetD3DManager`) and a D3D device inside the service; higher risk, revisit after
  WP3 ships.

### 3.2 DLL (media source)
- `IMFMediaSource::Start` opens the mapping/event; `RequestSample` copies the newest slot into a pooled
  `MFCreate2DMediaBuffer` (NV12) — one copy in the service, done by the Frame Server thread.
- Media types advertised: NV12 (first), YUY2, RGB32 (converted in-DLL only when requested; YUY2/RGB32 conversions
  are SIMD, shared with the helper's `pixel_swizzle`).
- Timestamps: `SetSampleTime` from the slot's QPC capture time (MF 100 ns units), duration from the advertised fps;
  duplicates re-delivered with +duration.
- `IMFVirtualCamera::Start` callback in the helper (`vcam_controller.cpp`): `SOURCE_START/STOP` events gate
  `vcamClients` — the pipeline renders only while a consumer streams.
- Creation stays cheap (no probe): geometry comes from the mapping header; before the first slot is written the
  stream returns the last frame or, only before the very first frame, the splash.

## 4. WP5 — Temporal segmentation tiers
| Tier | Hardware | Source | Notes |
|---|---|---|---|
| T0 | NPU + Windows Studio Effects + built-in camera | OS mask (`KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION` `_MASK`; `MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK` per sample) | Probe at camera start; if `_MASK` advertised, use it and set our keyer to `external_mask`; otherwise set `_OFF` to avoid double effects. |
| T1 | RTX with Tensor Cores | NVIDIA VFX SDK AI Green Screen (optional, redistributable) | Separate optional module; loaded only if the SDK redistributable is present. Licence/packaging decision pending. |
| T2 | Any DML GPU (incl. 1660 Ti) | MODNet fixed 512 (letterbox) + OFD (one-frame-delay flicker fix per authors; +33 ms) **or** RVM-MobileNetV3 fp16 if the GPL-3.0 decision allows | Default when T0/T1 unavailable. |
| T3 | iGPU-only / weak | MediaPipe SelfieSegmenter landscape 144×256 converted to ONNX (verify conversion + licence attribution) | Segmentation-grade edges; temporal smoothing via recurrent EMA in the mask domain only. |
Selection at engine start by a 2 s probe; persisted per machine; env override `BROADIFY_MEETING_KEYER_TIER`.

## 5. Risks
- D3D11/D3D12 shared buffers with DML IO binding are documented but rarely exercised with NV12 inputs: build a
  standalone Windows smoke test (`meeting-helper --gpu-selftest`) that runs in CI on windows-2022 (WARP adapter)
  so the code path is executed, not only compiled.
- LOCAL SERVICE access to `Global\` objects: validate the ACL with a ctest-style Windows smoke (open the mapping
  from a process impersonating LOCAL SERVICE is not possible in CI → manual field validation step in the runbook).
- Fallbacks: every new path has an env kill-switch to the WP0/WP1 behaviour.
