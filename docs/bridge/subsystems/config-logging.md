# Bridge Subsystem – Config & Logging

## Zweck
Dieses Subsystem verwaltet Runtime‑Konfiguration und Logging/Log‑Rotation der Bridge. Es stellt Status und Logs für Diagnose bereit.

## Verantwortlichkeiten
- Runtime‑Config (Outputs/Engine) setzen/lesen/clearen
- Status über `/status` bereitstellen
- Log‑Datei anlegen und rotieren
- Log‑Abruf und Filterung via `/logs`
- Bridge‑Context (u. a. bridgeId/bridgeName/Pairing‑Metadaten) bereitstellen

## Hauptkomponenten
- Runtime Config: `apps/bridge/src/services/runtime-config.ts`
- Log File Rotation: `apps/bridge/src/services/log-file.ts`
- Bridge Context: `apps/bridge/src/services/bridge-context.ts`
- Logs Route: `apps/bridge/src/routes/logs.ts`
- Status Route: `apps/bridge/src/routes/status.ts`

## Ablauf (Mermaid)
```mermaid
flowchart LR
  Startup --> LogFile[ensureBridgeLogFile]
  Startup --> Context[setBridgeContext]
  ConfigRoute[/config] --> RuntimeConfig
  StatusRoute[/status] --> RuntimeConfig
  LogsRoute[/logs] --> LogFile
```

## Security‑Hinweise
- Logs können sensitive Informationen enthalten → keine Tokens/Secrets loggen.
- `/logs` hat derzeit keine Auth‑Schicht.
- Pairing‑Code bleibt im Memory/Context und wird nicht geloggt.

## Log‑Level & Debug‑Flags
- Default‑Level: `info` (konfigurierbar über `BRIDGE_LOG_LEVEL`).
- Stdout‑Level: `BRIDGE_LOG_STDOUT_LEVEL`.
- File‑Level: `BRIDGE_LOG_FILE_LEVEL`.
- In `NODE_ENV=production` werden Bridge‑Logs mindestens auf `info` erzwungen,
  damit Errors, Output‑Configs und Graphics‑Payload‑Summaries immer im Log landen.
- Perf‑Logs nur bei `BRIDGE_LOG_PERF=1`.
- Renderer‑Debug nur bei `BRIDGE_GRAPHICS_DEBUG=1`.
- Stub‑Output Logs nur bei `BRIDGE_LOG_STUB_OUTPUT=1`.

## Fehlerbilder
- Log‑Datei nicht lesbar → `/logs` liefert 500
- Runtime‑Config inkonsistent → Status zeigt `configured`/`active` fehlerhaft

## Relevante Dateien
- `apps/bridge/src/services/runtime-config.ts`
- `apps/bridge/src/services/log-file.ts`
- `apps/bridge/src/services/bridge-context.ts`
- `apps/bridge/src/routes/logs.ts`
- `apps/bridge/src/routes/status.ts`
