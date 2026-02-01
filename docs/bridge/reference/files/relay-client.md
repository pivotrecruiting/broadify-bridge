# File Reference – apps/bridge/src/services/relay-client.ts

## Zweck
Maintained eine ausgehende WebSocket‑Verbindung zum Relay‑Server, empfängt Commands und sendet Results zurück.

## Ein-/Ausgänge
- Input: `bridgeId`, `relayUrl`, Logger
- Input (WS): `{ type: "command", command, payload, meta, signature }`
- Output (WS): `{ type: "command_result", success, data|error }`

## Abhängigkeiten
- `command-router.ts`
- `ws` (WebSocket)

## Side‑Effects
- Reconnect‑Backoff
- Logging (nur Command‑Name + requestId)
- Replay‑Schutz (jti‑Cache)

## Security
- Signatur‑Verifikation (Ed25519) + TTL + Replay‑Schutz
- Command‑Allowlist vor Dispatch
- Payloads sind untrusted → Validierung downstream (Zod)
- Public Keys via `BRIDGE_RELAY_SIGNING_PUBLIC_KEY` oder `BRIDGE_RELAY_JWKS_URL`
