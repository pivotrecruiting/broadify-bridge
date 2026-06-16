# broadify Virtual Camera — Windows (V1 Scaffold)

Media Foundation Virtual Camera support is planned for V2. V1 ships the macOS
CoreMediaIO extension scaffold only.

## Planned architecture

```
meeting-helper (C++) → FrameBus (RGBA8) → MF Virtual Camera plugin → Teams/Zoom/Meet
```

## V1 status

- No Windows native helper binary is built yet.
- The meeting sidecar reports `virtual_camera_native_target =
  media_foundation_virtual_camera` via `/api/platform/capabilities`.
- Use `debug_null` backend in the sidecar to validate the frame handoff path.

## Next steps (V2)

1. Implement an MF Virtual Camera source filter (C++/WinRT).
2. Reuse `Shared/include/framebus_reader.h` for FrameBus consumption.
3. Package the DLL with `electron-builder` under `resources/native/vcam-helper/`.
