# Desktop Subsystem – Logging & Diagnostics

## Zweck
Beschreibt Logging‑Pfad und Log‑Abruf für App und Bridge.

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant UI as Renderer UI
  participant Main as Main Process
  participant Bridge as Bridge HTTP

  UI->>Main: appGetLogs()
  Main-->>UI: app logs

  UI->>Main: bridgeGetLogs()
  Main->>Bridge: GET /logs
  Bridge-->>Main: logs
  Main-->>UI: logs
```

## Komponenten
- `src/electron/services/app-logger.ts`
- `src/electron/services/app-logs.ts`
- `src/electron/services/bridge-logs.ts`

## Relevante Dateien
- `src/electron/services/app-logger.ts`
- `src/electron/services/app-logs.ts`
- `src/electron/services/bridge-logs.ts`
