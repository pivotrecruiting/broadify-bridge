# File Reference – apps/bridge/src/services/relay-client.ts

## Zweck
Maintained eine ausgehende WebSocket‑Verbindung zum Relay‑Server, empfängt Commands und sendet Results zurück.
Der Client hält die Verbindung zusätzlich per aktivem WebSocket‑Heartbeat stabil und erkennt halb-offene Sockets schneller.

## Ein-/Ausgänge
- Input: `bridgeId`, `relayUrl`, Logger
- Input (WS): `{ type: "command", requestId, sequence, command, payload, meta, signature }`
- Output (WS): `bridge_hello` mit `protocolVersion`, `sessionId`, `lastProcessedSequence`
- Output (WS): `{ type: "command_received", requestId, bridgeId, sequence? }`
- Output (WS): `{ type: "command_result", success, data|error }`
- Output (WS): `{ type: "bridge_event", bridgeId, event, data?, timestamp }`

## Abhängigkeiten
- `command-router.ts`
- `ws` (WebSocket)

## Side‑Effects
- Reconnect‑Backoff
- Active heartbeat ping / pong liveness tracking
- Idle watchdog fallback for silent connections
- Command result dedupe cache for replayed `requestId`
- Logging (nur Command‑Name + requestId)
- Disconnect diagnostics with close code + reason
- Replay‑Schutz (jti‑Cache)
- Resync-Snapshots nach `bridge_auth_ok` (`bridge_status_snapshot`, `engine_status_snapshot`, `outputs_snapshot`, `graphics_snapshot`)

## Security
- Signatur‑Verifikation (Ed25519) + TTL + Replay‑Schutz
- Command‑Allowlist vor Dispatch
- Payloads sind untrusted → Validierung downstream (Zod)
- Public Keys via `BRIDGE_RELAY_SIGNING_PUBLIC_KEY` oder `BRIDGE_RELAY_JWKS_URL`
- Env‑Variablen werden beim Prozessstart gelesen; `.env` nur im Dev-Modus
  (siehe `apps/bridge/src/index.ts`).
