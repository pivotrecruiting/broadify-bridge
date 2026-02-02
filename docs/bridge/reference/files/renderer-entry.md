# File Reference – apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts

## Zweck
Renderer‑Entry für Offscreen‑Rendering: erstellt BrowserWindow je Layer, rendert HTML/CSS und sendet RGBA‑Frames via IPC.

## Ein-/Ausgänge
- Input: IPC‑Commands (`set_assets`, `create_layer`, ...)
- Output: `frame`‑Events mit RGBA‑Payload

## Abhängigkeiten
- Electron `BrowserWindow` (offscreen)
- Asset‑Protocol `asset://`

## Side‑Effects
- Offscreen Rendering, GPU/CPU Nutzung

## Security
- Sandbox + ContextIsolation + No Node Integration
- IPC Token‑Handshake
