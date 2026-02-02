# File Reference – src/electron/services/bridge-process-manager.ts

## Zweck
Startet/stoppt den Bridge‑Prozess (Dev: `npx tsx`, Prod: Electron als Node).

## Ein-/Ausgänge
- Input: `BridgeConfig` + optional `bridgeId`/`relayUrl`
- Output: `{ success, actualPort?, error? }`

## Side‑Effects
- Spawnt Child‑Process
- Log‑File in Production
