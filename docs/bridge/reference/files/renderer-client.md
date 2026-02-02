# File Reference – apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts

## Zweck
Startet den Electron‑Rendererprozess und kommuniziert via lokalem TCP‑IPC.

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

## Security
- Token‑Handshake, Payload‑Limits, localhost‑Bind
