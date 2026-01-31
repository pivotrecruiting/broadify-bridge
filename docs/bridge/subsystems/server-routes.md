# Bridge Subsystem – Server & Routes

## Zweck
Dieses Subsystem stellt die HTTP‑/WebSocket‑API der Bridge bereit, registriert Routen und initialisiert die Laufzeit‑Services.

## Verantwortlichkeiten
- Fastify‑Server erstellen und konfigurieren
- Plugins (CORS, WebSocket) registrieren
- Routen registrieren (Status, Outputs, Engine, Logs, etc.)
- Relay‑Client und Module initialisieren

## Hauptkomponenten
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/status.ts`
- `apps/bridge/src/routes/outputs.ts`
- `apps/bridge/src/routes/config.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/logs.ts`
- `apps/bridge/src/routes/websocket.ts`

## Ablauf (Mermaid)
```mermaid
flowchart LR
  Server[createServer] --> CORS
  Server --> WebSocket
  Server --> Modules
  Server --> RelayClient
  Server --> Routes

  Routes --> Status[/status]
  Routes --> Outputs[/outputs]
  Routes --> Config[/config]
  Routes --> Engine[/engine/*]
  Routes --> Logs[/logs]
  Routes --> WS[/ws]
```

## Routen (Auszug)
- `GET /status` – Laufzeit‑Status, Version, Engine‑Status
- `GET /outputs` – UI‑kompatible Output‑Liste
- `POST /config` – Runtime‑Config (Outputs/Engine)
- `POST /engine/connect` – Engine‑Connect
- `GET /engine/status` – Engine‑Status
- `GET /logs` – Bridge‑Logs (Tail + Filter)
- `GET /ws` – WebSocket Topic‑Subscription

## Security‑Hinweise
- CORS ist aktuell permissiv (dev‑freundlich).
- `/logs` hat keine Auth‑Schicht.
- Payload‑Validierung via Zod in den jeweiligen Routen.

## Relevante Dateien
- `apps/bridge/src/server.ts`
- `apps/bridge/src/routes/*`
