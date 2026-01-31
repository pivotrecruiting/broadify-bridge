# Integration – Schnittstellen (Desktop ↔ Bridge)

## Überblick
Diese Seite beschreibt die wichtigsten Schnittstellen zwischen Desktop‑App und Bridge (IPC + HTTP).

## Desktop IPC → Main
- `bridgeStart(config)` / `bridgeStop()`
- `bridgeGetStatus()` / `subscribeBridgeStatus(cb)`
- `bridgeGetOutputs()`
- `bridgeGetLogs()` / `bridgeClearLogs()`
- `appGetLogs()` / `appClearLogs()`
- `engineConnect()` / `engineDisconnect()` / `engineGetStatus()` / `engineGetMacros()` / `engineRunMacro()` / `engineStopMacro()`

## Main → Bridge HTTP
- `GET /status`
- `GET /relay/status`
- `GET /outputs`
- `POST /engine/connect`
- `POST /engine/disconnect`
- `GET /engine/status`
- `GET /engine/macros`
- `POST /engine/macros/:id/run`
- `POST /engine/macros/:id/stop`
- `GET /logs`
- `POST /logs/clear`

## Bridge Internal (Relay)
- `bridge_hello`, `command`, `command_result`

## Payloads
Siehe:
- `docs/bridge/features/graphics-commands.md`
- `docs/bridge/features/output-config.md`
- `docs/bridge/features/relay-protocol.md`
