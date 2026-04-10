# Bridge Subsystem – Server & Routes

## Zweck
Dieses Subsystem stellt die HTTP‑/WebSocket‑API der Bridge bereit, registriert Routen und initialisiert die Laufzeit‑Services.

## Verantwortlichkeiten
- Fastify‑Server erstellen und konfigurieren
- Plugins (CORS, WebSocket) registrieren
- Routen registrieren (Status, Devices, Outputs, Config, Engine, Video, Browser-Input, Relay, Logs, WS)
- Relay‑Client und Module initialisieren

## Hauptkomponenten
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/status.ts`
- `apps/bridge/src/routes/devices.ts`
- `apps/bridge/src/routes/outputs.ts`
- `apps/bridge/src/routes/config.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/video.ts`
- `apps/bridge/src/routes/graphics-browser-input.ts`
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
  Routes --> BrowserInput[/graphics/browser-input*]
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
- `GET /graphics/browser-input` – lokale Browser-Input-Seite fuer HTML5-Grafiken
- `GET /graphics/browser-input/state` – Snapshot fuer Browser-Input-Recover/Initialzustand
- `GET /graphics/browser-input/assets/:assetId` – Asset-Auslieferung fuer Browser-Input-Seite
- `GET /graphics/browser-input/ws` – Browser-Input-Live-Updates per WebSocket
- `GET /relay/status` – Relay-Verbindungsstatus
- `GET /logs` – Bridge‑Logs (Tail + Filter)
- `POST /logs/clear` – Log-Datei leeren
- `GET /ws` – WebSocket Topic‑Subscription

## Security‑Hinweise
- CORS ist aktuell permissiv (dev‑freundlich).
- Routen sind lokal oder token-geschützt (`BRIDGE_API_TOKEN`, Header `x-bridge-auth` / `Authorization`).
- Payload‑Validierung via Zod in den jeweiligen Routen.
- Der Browser-Input-Pfad ist fuer `v1` same-machine-first modelliert: die Bridge liefert in Status-Metadaten bewusst Loopback-URLs (`127.0.0.1`) aus, auch wenn die HTTP-Bindung im LAN weiter gefasst ist.
- Remote-Zugriff auf Browser-Input-Routen ist nur ueber den bestehenden local-or-token Guard erlaubt; unautorisierte WebSocket-Clients werden sofort mit Policy-Violation geschlossen.

## Relevante Dateien
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/*`
