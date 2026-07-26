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
- writes composited RGBA frames into FrameBus,
- exposes all stable control methods with structured responses,
- stores and renders `speaker_layout`, `cornerbug`, `media_layer` and
  `graphics` program sections,
- runs MODNet through ONNX Runtime as the primary keyer,
- keeps call-control and legacy prototype features disabled.

MediaPipe and Windows Media Foundation are added later without reintroducing
Python.

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
