# Integration – Schnittstellen (Desktop ↔ Bridge)

## Überblick
Diese Seite beschreibt die wichtigsten Schnittstellen zwischen Desktop‑App und Bridge (IPC + HTTP).

## Desktop IPC → Main
- `bridgeGetProfile()` / `bridgeSetName(name)`
- `bridgeStart(config)` / `bridgeStop()`
- `bridgeGetStatus()` / `subscribeBridgeStatus(cb)`
- `bridgeGetOutputs()`
- `bridgeGetLogs()` / `bridgeClearLogs()`
- `appGetLogs()` / `appClearLogs()`
- `engineConnect()` / `engineDisconnect()` / `engineGetStatus()` / `engineGetMacros()` / `engineRunMacro()` / `engineStopMacro()`
- fuer dokumentierte vMix-Script-Aktionen zusaetzlich: `engine_vmix_run_action`

## Main → Bridge HTTP
- `GET /status` (inkl. optional `bridgeName`)
- `GET /relay/status`
- `GET /outputs`
- `POST /engine/connect`
- `POST /engine/disconnect`
- `GET /engine/status`
- `GET /engine/macros`
- `POST /engine/macros/:id/run`
- `POST /engine/macros/:id/stop`
- `POST /engine/vmix/actions/run`
- `GET /logs`
- `POST /logs/clear`

## Bridge Internal (Relay)
- `bridge_hello`, `bridge_auth_challenge`, `bridge_auth_response`, `bridge_auth_ok`, `bridge_auth_error`, `command`, `command_result`
- Command: `bridge_pair_validate` (Pairing‑Code prüfen)

## Payloads
Siehe:
- `docs/bridge/features/graphics-commands.md`
- `docs/bridge/features/output-config.md`
- `docs/bridge/features/relay-protocol.md`
