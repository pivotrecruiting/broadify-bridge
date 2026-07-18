# Meeting Keyer And Rendering Dataflow

## Summary

The Meeting Helper uses one program compositor with two keyer execution modes.
On macOS, the primary MODNet path runs CoreML inference for the current camera
frame, refines the mask through Metal Performance Shaders, and composes that
same frame through Metal. If the fused path is unavailable, the helper resumes
the asynchronous latest-frame worker. Camera RGB and alpha masks remain
separate until the compositor boundary.

GPU acceleration is enabled by default when the platform backend initializes:

- macOS: native CoreML MODNet inference, MPS mask refine, Metal composition.
- Windows: ONNX Runtime DirectML inference, D3D11 composition and guided refine.
- Portable fallback: asynchronous Apple Vision on macOS, ONNX Runtime CPU on
  Windows, CPU guided refine and CPU composition.

Every GPU stage has a CPU or Vision fallback. A failed required texture upload
fails the complete GPU frame and rerenders it through the CPU compositor. It
never reports a successful frame with a missing camera, mask, or FrameBus
graphics layer.

## Control Plane

The existing public Meeting commands remain unchanged:

- `meeting_keyer_configure` maps to `keyer.configure`.
- `meeting_keyer_get` maps to `keyer.get`.
- `meeting_program_update` maps to `program.update`.
- `meeting_output_configure` controls FrameBus output.
- `meeting_graphics_configure_outputs` controls the graphics FrameBus inputs.

`keyer.configure` validates the model allowlist. Supported values are
`modnet` and `vision_person_segmentation`. Existing quality, performance,
mask, temporal, edge stabilization, and mask-age settings stay compatible.

Status responses add these fields without changing existing fields:

- `status.provider`: `coreml`, `vision_sequence`, `directml`, or `cpu`.
- `status.compositor`: `metal`, `d3d11`, or `cpu`.
- `status.keyer_pipeline_mode`: `fused_coreml`, `async_fallback`,
  `async_live_snap`, or `passthrough`.
- `status.pipeline_mode`: retains the existing helper lifecycle meaning.
- Detailed mask stage metrics expose remap, stabilization, close/dilate,
  feather, temporal, and total postprocess time.

## Keyer Selection And Fallbacks

### macOS

When `modnet` is requested:

1. `CoreMLKeyer` verifies all files in `MODNet.mlpackage` by SHA-256.
2. CoreML compiles and loads the model with all compute units enabled by
   default.
3. The primary program path synchronously evaluates the current camera frame
   and publishes the mask as `fused_coreml` with mask age zero.
4. MPS guided filtering refines the mask against the current camera frame.
5. If fused inference fails, the helper disables the fused path for the current
   keyer revision and resumes the asynchronous fallback worker.
6. After a successful model preflight, compile, initialization, or inference
   failures resume the asynchronous worker.
7. Because macOS ONNX is disabled in release builds, Apple Vision person
   segmentation produces the fallback mask.
8. If no keyer produces a valid mask, the program frame uses passthrough.

A missing or hash-invalid CoreML package fails the Bridge startup preflight.
Vision fallback is available only after the required release artifact has
passed that preflight and the helper has started.

The release build disables macOS ONNX Runtime because the vendored runtime does
not meet the macOS 13 deployment floor. CoreML is the primary production path,
with Apple Vision as the safe runtime fallback.

When `vision_person_segmentation` is explicitly requested, the helper uses the
asynchronous Vision path directly. Vision reuses a CoreVideo pixel buffer and
sequence request handler. A near-full-frame collapse resets the sequence
handler.

### Windows

When `modnet` is requested:

1. ONNX Runtime loads the hash-verified `modnet.onnx`.
2. The DirectML execution provider requests a high-performance GPU.
3. The session disables memory patterns and uses sequential execution as
   required by DirectML.
4. Dynamic input sizes follow the performance profile.
5. A new shape builds a fresh session and performs a warmup run before it is
   published.
6. If DirectML is unavailable, ONNX Runtime uses the CPU provider.

The Windows package must place these files next to `meeting-helper.exe`:

- `onnxruntime.dll`
- `onnxruntime_providers_shared.dll`
- `DirectML.dll`
- `models/modnet.onnx`

All three DLLs are included in package, signing, signature verification,
diagnostic collection, and installer smoke checks.

## Fused CoreML Pipeline

The default macOS MODNet path keeps the camera frame and its mask in the same
program iteration:

1. Capture publishes the newest camera frame.
2. `CoreMLKeyer` evaluates that frame with all CoreML compute units enabled.
3. `GpuMaskRefiner` scales the model mask, runs an MPS guided filter against
   the camera frame, and applies optional coefficient EMA stabilization.
4. The postprocessor applies close, remap, temporal, edge stabilization, and
   feather stages.
5. The compositor receives the current camera RGB and current refined alpha
   mask separately.
6. Metal renders the background, back FrameBus layer, keyed presenter, front
   FrameBus layer, generated graphics, and cornerbug.

The helper reports `keyer_pipeline_mode: "fused_coreml"`,
`degradation: "fused"`, and mask age zero. This mode intentionally couples
program FPS to CoreML inference throughput so the visible silhouette does not
trail the presenter.

Changing the camera, requested model, keyer settings, or enabled state bumps a
keyer revision. This recreates the fused keyer state and allows a previously
failed fused path to be retried safely.

## Asynchronous Fallback Pipeline

The fallback program loop never waits for inference.

1. Capture publishes the newest camera frame.
2. `AsyncKeyerWorker::submit` replaces any pending frame with the newest
   frame and records dropped or throttled submissions.
3. The worker runs the requested keyer, temporal blending, remap,
   stabilization, close/dilate, and feather stages.
4. A near-full-frame collapse is rejected and reports
   `mask_collapse_rejected`. The previous mask keeps its original source
   timestamp, so it ages into passthrough instead of sticking indefinitely.
5. The worker publishes an immutable shared mask result with its source-frame
   timestamp. The full source RGBA frame is not retained or copied.
6. The program loop checks mask age against `max_mask_age_ms`.
7. A usable mask is edge-refined against the current camera frame. D3D11 is
   used on Windows when available, otherwise the portable guided filter runs.
8. The current camera RGB and refined alpha mask are passed separately to the
   compositor.
9. If the mask is too old or absent, the current camera frame is rendered
   without keying.

Changing the camera, requested model, keyer settings, or enabled state bumps a
keyer revision. Pending work and the previous published mask are cleared before
the next submission, preventing temporal state from leaking across identities.

Normal asynchronous operation is reported as `async_live_snap`. A failed fused
CoreML attempt first reports `async_fallback`, then the worker publishes its
normal asynchronous status. This preserves a complete fallback path if the
model or GPU stage fails at runtime.

## Compositor

The GPU compose plan supports the production single-renderer path:

1. Background mode
2. Back graphics FrameBus layer
3. Camera layer with optional alpha mask
4. Front graphics FrameBus layer
5. Generated placeholder graphics
6. Cornerbug

Generated graphics and the cornerbug are drawn as cheap CPU overlays after the
Metal or D3D11 frame. They no longer disable the GPU compositor. An enabled
media layer still forces complete CPU composition because it does not yet have
a pixel-equivalent GPU implementation.

Metal and D3D11 cache layer textures by dimensions and timestamps. A required
camera, FrameBus graphics, or mask upload failure returns `false`. The caller
immediately renders the complete frame on CPU.

## Runtime Switches

GPU paths are default-on. These environment variables are emergency kill
switches or bounded tuning controls:

- `BROADIFY_MEETING_GPU_COMPOSITOR=0`: disable Metal composition.
- `BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0`: disable D3D11 composition.
- `BROADIFY_MEETING_GPU_PIPELINE=0`: disable the fused macOS CoreML path.
- `BROADIFY_MEETING_GPU_REFINE=0`: disable MPS mask refine.
- `BROADIFY_MEETING_GPU_GUIDED=0`: disable D3D11 guided refine.
- `BROADIFY_MEETING_GUIDED_REFINE=0`: disable live guided refine.
- `BROADIFY_MEETING_KEYER_DML_LEGACY=1`: use DirectML device 0.
- `BROADIFY_MEETING_COREML_UNITS`: `cpuOnly`, `cpuAndGPU`,
  `cpuAndNeuralEngine`, or the default `all`.
- `BROADIFY_MEETING_GUIDED_RADIUS`: positive guided-filter radius.
- `BROADIFY_MEETING_GUIDED_EPSILON`: positive guided-filter epsilon.
- `BROADIFY_MEETING_GPU_RADIUS`: positive MPS guided-filter radius.
- `BROADIFY_MEETING_GPU_EPSILON`: positive MPS guided-filter epsilon.
- `BROADIFY_MEETING_GPU_REFINE_WIDTH`: positive MPS output width.
- `BROADIFY_MEETING_GPU_EMA`: MPS coefficient EMA value from 0.05 to 1.0.

The Bridge forwards only this fixed allowlist to the helper. This explicit
forwarding is required because macOS LaunchServices does not reliably preserve
the environment of `/usr/bin/open`. Values are restricted to bounded tuning
tokens, redacted in lifecycle logs, and are not exposed as arbitrary remote
command inputs.

## Model Release Artifacts

Windows keeps the existing ONNX model download and manifest verification.

macOS requires `MODNet.mlpackage`. Prepare it with:

```bash
MODNET_COREML_MODEL_SOURCE=/path/to/model-parent \
  npm run prepare:modnet-coreml-model
```

CI can instead provide `MODNET_COREML_MODEL_URL`, pointing to a ZIP archive
that contains `MODNet.mlpackage`. Preparation and release verification compare
all three package files with `models/coreml-manifest.json`.

Electron Builder copies the verified package to
`resources/native/meeting-helper/models/MODNet.mlpackage`.

During development, the Bridge resolves the model directory beside the helper
app bundle, not inside `Contents/MacOS`. It refuses to start the helper and
reports `keyer_model_missing` when the required platform model is absent.

## Verification

Portable native regression test:

```bash
npm run test:meeting-helper-native
```

Portable GPU to CPU parity test:

```bash
npm run test:meeting-helper-gpu
```

Portable keyer inference test:

```bash
npm run test:meeting-helper-keyer
```

The compositor self-test renders the same keyed frame on CPU and Metal or
D3D11 and fails when rendering fails, output sizes differ, or any channel
differs by more than two levels. It also verifies that generated graphics and a
cornerbug do not downgrade the integrated compositor.

On GitHub-hosted Windows runners the portable commands force D3D11 WARP and the
ONNX CPU provider. This still executes the real shader, model, packaged DLLs,
MSI installation and NSIS installation without assuming GPU hardware on the
runner. The self-test-only variables do not change production defaults.

Strict Windows hardware tests use:

```bash
npm run test:meeting-helper-gpu-hardware
npm run test:meeting-helper-keyer-hardware
```

The `Meeting Helper Preflight` workflow exposes these commands through its
manual `run_windows_hardware_tests` input on a self-hosted runner labeled
`broadify-gpu`. macOS release verification additionally hashes the packaged
CoreML model and executes both self-tests from the final app bundle.

## Explicitly Deferred Gabriel Scope

This integration does not include recording, multi-camera, conference control,
Stream Deck, power control, call control, background uploads, free file paths,
or remote URLs. Those features require separate reviewed contracts and
security boundaries.
