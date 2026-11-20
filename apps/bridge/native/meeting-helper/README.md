# broadify Meeting Helper

Native C++ helper for the Meeting feature. The helper replaces the former
Python/FastAPI sidecar and keeps frame transport on FrameBus shared memory.

## Responsibilities

- JSON-RPC control server over a local Unix socket or Windows named pipe.
- FrameBus RGBA8 producer for program output.
- Local MJPEG preview endpoint at `/preview.mjpg`.
- Native pipeline host for camera capture, keying and compositing.

## Current Implementation

The current implementation is native-only:

- captures macOS cameras through AVFoundation,
- captures macOS 14+ screen shares through the ScreenCaptureKit system picker,
- writes composited RGBA frames into FrameBus,
- exposes all stable control methods with structured responses,
- captures Windows screen/window sources through Windows.Graphics.Capture,
- stores and renders `speaker_layout`, `cornerbug`, `media_layer` and
  `graphics` program sections,
- exposes the screen-capture abstraction and current stub,
- runs MODNet through ONNX Runtime as the primary keyer,
- keeps call-control and legacy prototype features disabled.

MediaPipe and Windows Media Foundation are added later without reintroducing
Python.

## Portrait Program (9:16)

The program canvas is a start parameter (`--width` / `--height` / `--fps`,
default 1920x1080). With a portrait canvas (`--width 1080 --height 1920`) the
helper renders a real 1080x1920 program:

- **Capture stays landscape.** Camera modes and screen-capture bounds are
  requested with `captureRequestSize()` (`common/options.h`), i.e. 1920x1080
  for a 1080x1920 canvas. The compositor cover-fits the un-keyed camera.
- **The keyed presenter is scaled uniformly by the canvas height**
  (`keyedPresenterHeightFitScale` in `compose/program_geometry.h`) instead of
  per axis: it is never squeezed and, anchored at the bottom, never cropped
  vertically. A camera wider than the canvas (any landscape camera on 9:16,
  factor 1.78 for 1920x1080) is cropped left and right around the speaker
  position; a camera narrower than the canvas (4:3 on 16:9, 640x480 becomes
  1440x1080) leaves the background visible beside it. With a 16:9 camera on a
  16:9 canvas nothing changes.
- **Canvas-sized sinks** follow the canvas unchanged: FrameBus, MJPEG preview,
  WebRTC program stream and the recorder (the file is 1080x1920).
- **The virtual camera is a 16:9-only sink.** The helper pillarboxes the
  portrait program into 1920x1080 (`util/frame_fit.h`: opaque black bars,
  centered) before it leaves the process - in the raw-frame server (macOS
  CMIO extension, Windows TCP fallback; the `X-Broadify-Frame-*` handshake
  headers advertise 1920x1080) and in the Windows shared-memory publisher. The
  system extension, the Windows service and the `vcam_shm_layout` limits are
  untouched. The raw-frame server's `frame_sent` event logs the delivered
  record as `width`/`height` and adds the program size as
  `source_width`/`source_height` when the frame was fitted.
- Camera PiP inset: 28% of the long edge, capped at 45% of the canvas width;
  margin and border follow the short edge. Cornerbug size and the speaker
  layout travel stay width-relative.

A landscape canvas takes the same code paths as before (pinned by
`program_geometry_test`, `frame_fit_test`, `raw_frame_server_test`).

## MODNet Dependencies

The macOS build expects vendored ONNX Runtime here:

```text
apps/bridge/native/meeting-helper/deps/onnxruntime/macos-arm64/
├── include/onnxruntime_cxx_api.h
└── lib/libonnxruntime.dylib
```

### Windows ONNX Runtime (DirectML)

The Windows build vendors the DirectML-enabled ONNX Runtime here:

```text
apps/bridge/native/meeting-helper/deps/onnxruntime/windows-x64/
├── include/  (onnxruntime_cxx_api.h, dml_provider_factory.h, …)
└── lib/  onnxruntime.dll · onnxruntime.lib · onnxruntime_providers_shared.dll · DirectML.dll
```

The Windows keyer runs the **DirectML** execution provider (GPU offload) with an
automatic CPU fallback. The active provider is reported in `keyer.get` /
`state.get` (`provider: "directml" | "cpu"`) for support diagnostics.

**Version divergence (temporary).** Windows uses ONNX Runtime **1.24.4 (DirectML
build)**; macOS uses **1.26.0 (CPU/CoreML build)**. There is no official 1.26.0
DirectML distribution — the `Microsoft.ML.OnnxRuntime.DirectML` NuGet series ends
at 1.24.4, and the GitHub 1.26.0 release ships only CPU + CUDA (NVIDIA) builds.
The previous CPU-only 1.26.0 build is kept as a backup at
`deps/onnxruntime/windows-x64-cpu-1.26.0.bak/`.

Vendored packages (both signed by Microsoft, Authenticode `Valid`):

| Package | Version | nupkg SHA-256 |
| --- | --- | --- |
| `Microsoft.ML.OnnxRuntime.DirectML` | 1.24.4 | `57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681` |
| `Microsoft.AI.DirectML` (DirectML.dll) | 1.15.4 | `4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9` |

**TODO:** unify Windows and macOS on one ONNX Runtime version once an official
DirectML build for that version is published.

The model must be placed here:

```text
apps/bridge/native/meeting-helper/models/modnet.onnx
```

Update `models/manifest.json` with the concrete SHA-256:

```bash
bash scripts/hash-meeting-model.sh modnet.onnx
```

Builds fail when MODNet artifacts are missing. For a local non-keying build:

```bash
MEETING_HELPER_ENABLE_MODNET=0 bash apps/bridge/native/meeting-helper/build.sh
```

## Build

macOS:

```bash
bash apps/bridge/native/meeting-helper/build.sh
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\bridge\native\meeting-helper\build.ps1
```
