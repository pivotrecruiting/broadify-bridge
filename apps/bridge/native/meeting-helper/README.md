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
