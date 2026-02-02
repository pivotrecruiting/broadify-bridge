# Desktop Subsystem – Preload & IPC

## Zweck
Das Preload‑Subsystem definiert die sichere API‑Oberfläche (`window.electron`) und kapselt alle IPC‑Aufrufe für den Renderer.

## Verantwortlichkeiten
- Whitelist der erlaubten IPC‑Calls
- Typed IPC‑Invoke und Event‑Subscriptions
- Isolierung des Renderer vom Main Process

## Hauptkomponenten
- `src/electron/preload.cts`
- `src/electron/types.ts`

## IPC‑API (Auszug)
- `bridgeGetProfile()` / `bridgeSetName(name)`
- `bridgeStart(config)` / `bridgeStop()`
- `bridgeGetStatus()` / `subscribeBridgeStatus(cb)`
- `bridgeGetOutputs()`
- `bridgeGetLogs()` / `bridgeClearLogs()`
- `engineConnect()` / `engineGetStatus()` / `engineRunMacro()`
- `openExternal(url)`

## Security‑Hinweise
- Renderer hat keinen Node‑Zugriff; Preload ist die einzige Brücke.
- API ist minimal und whitelisted.

## Relevante Dateien
- `src/electron/preload.cts`
- `src/electron/types.ts`
