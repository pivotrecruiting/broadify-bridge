# File Reference – src/electron/main.ts

## Zweck
Main‑Process Entry: Fenster‑Lifecycle, IPC‑Handlers, Bridge‑Start/Stop, Health‑Checks, Log‑Zugriff und Updater-Status.

## Ein-/Ausgänge
- Input: IPC calls (`bridgeStart`, `bridgeStop`, `engine*`)
- Output: IPC responses + `bridgeStatus`/`updaterStatus` events

## Abhängigkeiten
- `bridge-process-manager.ts`
- `bridge-health-check.ts`
- `bridge-outputs.ts`, `bridge-logs.ts`
- `network-interface-detector.ts`
- `app-updater.ts`

## Side‑Effects
- Spawnt Bridge‑Prozess
- Periodisches Health‑Polling
- Initialisiert BrowserWindow und Single-Instance Verhalten
