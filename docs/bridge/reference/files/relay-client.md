# File Reference – apps/bridge/src/services/relay-client.ts

## Zweck
Maintained eine ausgehende WebSocket‑Verbindung zum Relay‑Server, empfängt Commands und sendet Results zurück.

## Ein-/Ausgänge
- Input: `bridgeId`, `relayUrl`, Logger
- Input (WS): `{ type: "command", command, payload }`
- Output (WS): `{ type: "command_result", success, data|error }`

## Abhängigkeiten
- `command-router.ts`
- `ws` (WebSocket)

## Side‑Effects
- Reconnect‑Backoff
- Logging (inkl. sanitized Graphics payloads)

## Security
- Payloads sind untrusted → Validierung downstream (Zod)
