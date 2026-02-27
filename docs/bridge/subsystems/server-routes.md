# Bridge Subsystem – Server & Routes

## Zweck
Dieses Subsystem stellt die HTTP‑/WebSocket‑API der Bridge bereit, registriert Routen und initialisiert die Laufzeit‑Services.

## Verantwortlichkeiten
- Fastify‑Server erstellen und konfigurieren
- Plugins (CORS, WebSocket) registrieren
- Routen registrieren (Status, Devices, Outputs, Config, Engine, Video, Relay, Logs, WS)
- Relay‑Client und Module initialisieren

## Hauptkomponenten
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/status.ts`
- `apps/bridge/src/routes/devices.ts`
- `apps/bridge/src/routes/outputs.ts`
- `apps/bridge/src/routes/config.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/video.ts`
- `apps/bridge/src/routes/relay.ts`
- `apps/bridge/src/routes/logs.ts`
- `apps/bridge/src/routes/websocket.ts`
- `apps/bridge/src/routes/route-guards.ts`

## Ablauf (Mermaid)
```mermaid
flowchart LR
  Server[createServer] --> CORS
  Server --> WebSocket
  Server --> Modules
  Server --> RelayClient
  Server --> Routes

  Routes --> Status[/status]
  Routes --> Devices[/devices]
  Routes --> Outputs[/outputs]
  Routes --> Config[/config]
  Routes --> Engine[/engine/*]
  Routes --> Video[/video/status]
  Routes --> Relay[/relay/status]
  Routes --> Logs[/logs]
  Routes --> WS[/ws]
```

## Routen (Auszug)
- `GET /status` – Laufzeit‑Status, Version, Engine‑Status, optionaler `bridgeName`
- `GET /devices` – Rohes Device/Port-Inventar
- `GET /outputs` – UI‑kompatible Output‑Liste
- `POST /config` – Runtime‑Config (Outputs/Engine)
- `POST /config/clear` – Runtime‑Config zurücksetzen
- `POST /engine/connect` – Engine‑Connect
- `GET /engine/status` – Engine‑Status
- `GET /video/status` – Video-Status (aktuell Placeholder)
- `GET /relay/status` – Relay-Verbindungsstatus
- `GET /logs` – Bridge‑Logs (Tail + Filter)
- `POST /logs/clear` – Log-Datei leeren
- `GET /ws` – WebSocket Topic‑Subscription

## Security‑Hinweise
- CORS ist aktuell permissiv (dev‑freundlich).
- Routen sind lokal oder token-geschützt (`BRIDGE_API_TOKEN`, Header `x-bridge-auth` / `Authorization`).
- Payload‑Validierung via Zod in den jeweiligen Routen.

## Relevante Dateien
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/*`
