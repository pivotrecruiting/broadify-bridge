# Integration Flow – Relay (Cloud ↔ Bridge)

## Ziel
Beschreibt den Datenfluss zwischen Cloud‑Relay und Bridge (Commands + Results).

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant Relay as Relay Server
  participant Bridge as RelayClient
  participant Router as CommandRouter

  Bridge->>Relay: WS connect
  Bridge->>Relay: bridge_hello (bridgeId, version, optional bridgeName)
  Relay->>Bridge: command (graphics_*)
  Bridge->>Router: handleCommand
  Router-->>Bridge: result
  Bridge-->>Relay: command_result
```

## Komponenten
- Bridge: `apps/bridge/src/services/relay-client.ts`
- Router: `apps/bridge/src/services/command-router.ts`

## Reconnect
- Exponentieller Backoff (1s → 60s)

## Sicherheit
- Payloads sind untrusted → Validierung downstream (Zod)
- Logging mit sanitized CSS‑Payloads
- Pairing‑Command validiert Code + Ablaufzeit im Bridge‑Context

## Relevante Dateien
- `apps/bridge/src/services/relay-client.ts`
- `apps/bridge/src/services/command-router.ts`
