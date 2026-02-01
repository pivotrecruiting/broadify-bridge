# Integration Flow – Health/Status (E2E)

## Ziel
Beschreibt den Status‑Flow vom Desktop UI bis zur Bridge und optional zum Relay.

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant UI as Desktop UI
  participant Main as Electron Main
  participant Bridge as Bridge HTTP
  participant Relay as Relay Server

  UI->>Main: bridgeGetStatus()
  Main->>Bridge: GET /status
  Bridge-->>Main: status
  Main->>Bridge: GET /relay/status
  Bridge-->>Main: relay status
  Main-->>UI: bridgeStatus event
```

## Komponenten
- Desktop: `src/electron/main.ts`, `src/electron/services/bridge-health-check.ts`
- Bridge: `apps/bridge/src/routes/status.ts`, `apps/bridge/src/routes/relay.ts`
- Relay: `apps/bridge/src/services/relay-client.ts`

## Hinweise
- Pairing‑Infos stammen aus dem Main‑Process (nicht aus `/status`).
- `webAppUrl` wird im Main‑Process erzeugt und nicht von der Bridge geliefert.
- `webAppUrl` enthaelt nur die Bridge‑ID; Pairing‑Code wird nicht ueber die URL transportiert.

## Felder (BridgeStatus)
- `running`, `reachable`, `version`, `uptime`, `mode`, `host`, `port`
- `relayConnected`, `bridgeId`, `bridgeName` (falls Relay aktiv)
- `webAppUrl` (vom Main gebaut)
- `pairingCode`, `pairingExpiresAt`, `pairingExpired` (vom Main ergänzt)

## Fehlerbilder
- Port belegt → Status liefert Fehler
- Relay nicht konfiguriert → `relayConnected=false`

## Relevante Dateien
- `src/electron/services/bridge-health-check.ts`
- `apps/bridge/src/routes/status.ts`
- `apps/bridge/src/routes/relay.ts`
