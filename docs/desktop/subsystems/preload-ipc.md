# Desktop Subsystem – Preload & IPC

## Zweck
Das Preload‑Subsystem definiert die sichere API‑Oberfläche (`window.electron`) und kapselt alle IPC‑Aufrufe für den Renderer.

## Verantwortlichkeiten
- Whitelist der erlaubten IPC‑Calls
- Typed IPC‑Invoke und Event‑Subscriptions
- Isolierung des Renderer vom Main Process
- Keine direkten Node/Electron APIs im UI-Code ausserhalb von `window.electron`

## Hauptkomponenten
- `src/electron/preload.cts`
- `src/electron/types.ts`

## IPC‑API (Auszug)
- `appGetVersion()`
- `bridgeGetProfile()` / `bridgeAcceptTerms()` / `bridgeSetName(name)`
- `bridgeStart(config)` / `bridgeStop()`
- `bridgeGetStatus()` / `subscribeBridgeStatus(cb)`
- `getNetworkConfig()` / `detectNetworkInterfaces()` / `getNetworkBindingOptions()`
- `checkPortAvailability()` / `checkPortsAvailability()`
- `bridgeGetOutputs()`
- `bridgeGetLogs()` / `bridgeClearLogs()`
- `appGetLogs()` / `appClearLogs()`
- `updaterGetStatus()` / `updaterCheckForUpdates()`
- `updaterDownloadUpdate()` / `updaterQuitAndInstall()`
- `subscribeUpdaterStatus(cb)`
- `engineConnect()` / `engineDisconnect()` / `engineGetStatus()` / `engineGetMacros()` / `engineRunMacro()` / `engineStopMacro()`
- `openExternal(url)`

Hinweis:

- Diese Engine-IPC-Methoden bleiben im Desktop-Contract verfuegbar, die produktive Bedienung erfolgt jedoch bewusst ueber die WebApp als Single Source of Truth.

## Security‑Hinweise
- Renderer hat keinen Node‑Zugriff; Preload ist die einzige Brücke.
- API ist minimal und whitelisted.

## Relevante Dateien
- `src/electron/preload.cts`
- `src/electron/types.ts`
