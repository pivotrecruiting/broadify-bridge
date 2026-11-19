# File Reference – apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts

## Zweck
Renderer‑Entry für Offscreen‑Rendering: erstellt ein gemeinsames BrowserWindow, rendert HTML/CSS und schreibt RGBA‑Frames in den FrameBus. Fractional Broadcast‑FPS bleiben im Control‑Plane‑Format erhalten und werden nur für Electron, FrameBus und native Display‑Helper mit Integer‑FPS gerundet.

Studio-Renderer-Recovery attached den FrameBus-Writer per Name an die bestehende
Region (`forceRecreate: false`). Eine Force-Recreation ist nur der
inkompatible-Region-Self-Heal. Wenn die wiederverwendete Region bereits Frames
trägt (`seq > 0`), seedet der Entry kein Idle-Frame und lässt das letzte Bild
stehen, bis die Layer-Replay-Commands eintreffen.

## Ein-/Ausgänge
- Input: IPC‑Commands (`set_assets`, `create_layer`, ...)
- Output: RGBA‑Frames im FrameBus sowie Status-/Fehler‑Events über IPC

## Abhängigkeiten
- Electron `BrowserWindow` (offscreen)
- Asset‑Protocol `asset://`

## Side‑Effects
- Offscreen Rendering, GPU/CPU Nutzung
- Stoppt den FrameBus-Heartbeat bei Chromium-Renderer-Crash oder dauerhaft
  unresponsive Offscreen-Fenster, erstellt das Single-Window neu und spielt
  gespeicherte Layer-Snapshots erneut ein; wiederholte Vorfälle innerhalb von
  60 s führen zu Exit-Code 3 für die Prozess-Recovery.

## Security
- Sandbox + ContextIsolation + No Node Integration
- IPC Token‑Handshake
