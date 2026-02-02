# File Reference – src/electron/services/bridge-health-check.ts

## Zweck
Polling von `/status` (und optional `/relay/status`) zur Bridge‑Erreichbarkeit.

## Ein-/Ausgänge
- Input: BridgeConfig
- Output: `BridgeStatus`

## Side‑Effects
- Periodischer Timer (2s)
