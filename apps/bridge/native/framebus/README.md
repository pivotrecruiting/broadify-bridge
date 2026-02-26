# FrameBus Native Addon

Dieses Verzeichnis enthält das N-API Grundgerüst für den FrameBus.

## Status
- N-API Addon für `createWriter()` / `openReader()` vorhanden.
- Shared Memory Backends:
  - macOS/Linux: POSIX `shm_open` + `mmap`
  - Windows: `CreateFileMapping` / `OpenFileMapping`
- API-Spec: `docs/bridge/refactor/graphics-realtime-framebus-napi-api.md`
- C-Header: `include/framebus.h`

## Build (später)
- `node-gyp rebuild` oder per Projekt-Buildsystem.
