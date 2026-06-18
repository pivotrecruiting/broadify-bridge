# File Reference – apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts

## Zweck
Startet den Electron‑Rendererprozess und kommuniziert via lokalem TCP‑IPC.
Bei abnormalem Renderer-Exit wird begrenzte Runtime-Recovery versucht. Der zweite Versuch
nutzt GPU-Fallback, sofern nicht per `BRIDGE_GRAPHICS_AUTO_GPU_FALLBACK=0` deaktiviert.

## Ein-/Ausgänge
- Input: Render‑Commands (`create_layer`, `update_values`, ...)
- Output: Frames via `onFrame` callback

## Abhängigkeiten
- `graphics-renderer.ts` (Interface)
- `node:net` (IPC)
- `node:child_process` (spawn)

## Side‑Effects
- Spawnt Electron‑Prozess
- Erstellt lokalen IPC‑Server
- Setzt `BRIDGE_GRAPHICS_USER_DATA_DIR` auf ein isoliertes Renderer-Profil
- Löscht bei Recovery nur volatile Cache-Pfade innerhalb dieses Profils
- Kann bei wiederholtem Renderer-Absturz mit `BRIDGE_GRAPHICS_DISABLE_GPU=1` neu starten
- Wechselt nach zwei Recovery-Versuchen in 5 Minuten in `degraded`

## Security
- Token‑Handshake, Payload‑Limits, localhost‑Bind
