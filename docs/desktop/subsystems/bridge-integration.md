# Desktop Subsystem – Bridge Integration

## Zweck
Beschreibt wie die Desktop‑App die Bridge startet, überwacht und anspricht.

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant UI as Renderer UI
  participant Main as Main Process
  participant BPM as BridgeProcessManager
  participant Bridge as Bridge HTTP

  UI->>Main: bridgeStart(config)
  Main->>BPM: start(config)
  BPM-->>Main: success/actualPort
  Main->>Bridge: /status polling
  Bridge-->>Main: status
  Main-->>UI: bridgeStatus event
```

## Komponenten
- `src/electron/services/bridge-process-manager.ts`
- `src/electron/services/bridge-health-check.ts`
- `src/electron/services/bridge-outputs.ts`
- `src/electron/services/bridge-profile.ts`
- `src/electron/services/bridge-pairing.ts`

## Hinweise
- Der Main‑Process erzeugt einen Pairing‑Code pro Start und gibt ihn per Env‑Var an die Bridge weiter.
- Die Bridge kann ohne gesetzten Namen nicht gestartet werden.
- Relay wird beim Bridge‑Start (GUI) aktiviert und beim Stop deaktiviert.

## Fehlerbilder
- Port belegt → autoFallback oder Fehler
- Bridge nicht erreichbar → Status `reachable=false`
- Bridge‑Name fehlt → Start wird abgelehnt

## Relevante Dateien
- `src/electron/main.ts`
- `src/electron/services/bridge-process-manager.ts`
- `src/electron/services/bridge-health-check.ts`
