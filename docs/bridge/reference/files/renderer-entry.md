# File Reference – apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts

## Zweck
Renderer‑Entry für Offscreen‑Rendering: erstellt ein gemeinsames BrowserWindow, rendert HTML/CSS und schreibt RGBA‑Frames in den FrameBus. Fractional Broadcast‑FPS bleiben im Control‑Plane‑Format erhalten und werden nur für Electron, FrameBus und native Display‑Helper mit Integer‑FPS gerundet.

## Ein-/Ausgänge
- Input: IPC‑Commands (`set_assets`, `create_layer`, ...)
- Output: RGBA‑Frames im FrameBus sowie Status-/Fehler‑Events über IPC

## Abhängigkeiten
- Electron `BrowserWindow` (offscreen)
- Asset‑Protocol `asset://`

## Side‑Effects
- Offscreen Rendering, GPU/CPU Nutzung

## Security
- Sandbox + ContextIsolation + No Node Integration
- IPC Token‑Handshake
