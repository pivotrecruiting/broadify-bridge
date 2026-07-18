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
- runs native CoreML MODNet with Apple Vision fallback on macOS,
- runs MODNet through ONNX Runtime DirectML with CPU fallback on Windows,
- uses Metal or D3D11 composition with atomic CPU fallback,
- exits through a parent-process watchdog when the Bridge terminates,
- keeps call-control and legacy prototype features disabled.

Recording, multi-camera, conference and call-control features are intentionally
outside this helper scope.

## MODNet Dependencies

The macOS release uses the verified CoreML package:

```text
apps/bridge/native/meeting-helper/models/MODNet.mlpackage/
```

Prepare it from an approved artifact source:

```bash
MODNET_COREML_MODEL_SOURCE=/path/to/model-parent npm run prepare:modnet-coreml-model
```

The Windows build expects the DirectML NuGet runtime layout under:

```text
apps/bridge/native/meeting-helper/deps/onnxruntime/windows-x64/
├── include/onnxruntime_cxx_api.h
└── lib/
    ├── onnxruntime.lib
    ├── onnxruntime.dll
    ├── onnxruntime_providers_shared.dll
    └── DirectML.dll
```

Windows also requires the hash-verified model at
`models/modnet.onnx`. For a local compiler-only build without ONNX Runtime:

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

## Verification

```bash
npm run test:meeting-helper-native
npm run test:meeting-helper-gpu
npm run test:meeting-helper-keyer
```

The GPU and keyer self-tests require access to the real Metal, CoreML, D3D11,
or DirectML backend selected for the platform.
