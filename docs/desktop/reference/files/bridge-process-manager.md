# File Reference – src/electron/services/bridge-process-manager.ts

## Zweck
Startet/stoppt den Bridge‑Prozess (Dev: `npx tsx`, Prod: Electron als Node).

## Ein-/Ausgänge
- Input: `BridgeConfig` + `bridgeId`/`relayUrl`/`bridgeName` + Pairing/Relay-Flags
- Output: `{ success, actualPort?, error? }`

## Side‑Effects
- Spawnt Child‑Process
- `bridge-process.log` in Production
