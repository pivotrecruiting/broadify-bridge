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
- Delegiert den verzögerten Engine-Startup-Reconnect an
  `engineAdapter.startPersistedAutoConnect()` nach `listen()` und optionalem
  Relay-Connect. Die Timer-/Retry-Logik liegt damit im EngineAdapterService,
  nicht mehr in `server.ts`.

## Shutdown-Reihenfolge
- `engineAdapter.beginShutdown()` ist das ERSTE Statement im Shutdown-Handler.
  Dadurch werden Engine-Reconnects unterdrückt, bevor weitere Stop-Schritte
  laufen.
- Direkt danach setzt `meetingHelperManager.beginShutdown()` sein Shutdown-Flag:
  Das Prozessgruppen-SIGTERM kann den Meeting-Helper töten, bevor der
  Meeting-Stop-Schritt läuft; ohne das Flag würde dieser Exit als Crash
  klassifiziert und mitten im Shutdown ein Restart-Timer gestellt.
- Nach `stopCommandRouter()` wird `engineAdapter.disconnect()` mit 7 s Budget
  ausgeführt, bevor der Relay-Client getrennt wird. So kann der finale
  `engine_status disconnected` noch über Relay gesendet werden.

## Fehlerfälle
- Port belegt (`EADDRINUSE`)
- Host nicht verfügbar (`EADDRNOTAVAIL`)
