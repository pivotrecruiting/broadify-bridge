# File Reference – apps/bridge/src/server.ts

## Zweck
Erstellt und startet den Fastify‑Server, initialisiert Logger/Context, Device‑Module und Relay‑Client und registriert alle Routen.

## Ein-/Ausgänge
- Input: `BridgeConfigT` (host, port, mode, bridgeId, relayUrl, userDataDir)
- Output: Fastify‑Instance (mit registrierten Routen)

## Abhängigkeiten
- Routen: `routes/*`
- Logging: `log-file.ts`, `console-to-pino.ts`
- Context: `bridge-context.ts`
- Graphics: `graphics-manager.ts`
- Devices: `device-cache.ts`, `modules/index.ts`

## Side‑Effects
- Initialisiert Asset‑ und Output‑Config (GraphicsManager)
- Startet Device‑Watcher
- Optional: startet Relay‑Client
- Registriert CORS/WebSocket Plugins

## Shutdown-Reihenfolge
- `meetingHelperManager.beginShutdown()` ist das ERSTE Statement im
  Shutdown-Handler (vor Logging und allen Stop-Schritten): Das
  Prozessgruppen-SIGTERM kann den Meeting-Helper töten, bevor der
  Meeting-Stop-Schritt läuft; ohne das Flag würde dieser Exit als Crash
  klassifiziert und mitten im Shutdown ein Restart-Timer gestellt.

## Fehlerfälle
- Port belegt (`EADDRINUSE`)
- Host nicht verfügbar (`EADDRNOTAVAIL`)
