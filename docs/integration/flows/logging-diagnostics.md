# Integration Flow – Logging & Diagnose

## Ziel
Beschreibt den Diagnose‑Flow für Logs (Desktop + Bridge) und die beteiligten Schnittstellen.

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant UI as Desktop UI
  participant Main as Electron Main
  participant Bridge as Bridge HTTP

  UI->>Main: appGetLogs()
  Main-->>UI: app log content

  UI->>Main: bridgeGetLogs()
  Main->>Bridge: GET /logs
  Bridge-->>Main: bridge log content
  Main-->>UI: bridge log content

  UI->>Main: bridgeClearLogs()
  Main->>Bridge: POST /logs/clear
  Bridge-->>Main: cleared
```

## Komponenten
- Desktop: `src/electron/services/app-logs.ts`, `src/electron/services/app-logger.ts`
- Bridge: `apps/bridge/src/routes/logs.ts`, `apps/bridge/src/services/log-file.ts`

## Fehlerbilder
- Logdatei fehlt → leere Antwort
- Bridge nicht erreichbar → HTTP‑Fehler

## Relevante Dateien
- `src/electron/services/app-logs.ts`
- `src/electron/services/bridge-logs.ts`
- `apps/bridge/src/routes/logs.ts`
- `apps/bridge/src/services/log-file.ts`
