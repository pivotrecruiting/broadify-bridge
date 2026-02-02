# File Reference – src/ui/hooks/*

## Zweck
React‑Hooks für Bridge‑Status, Network‑Config, Port‑Verfügbarkeit und Engine‑Status/Macros.

## Enthalten (Auszug)
- `use-bridge-status.ts`
- `use-network-config.ts`
- `use-network-binding.ts`
- `use-port-availability.ts`
- `use-engine-status.ts`
- `use-engine-macros.ts`

## Side‑Effects
- IPC‑Calls via `window.electron`
- Polling (Engine‑Status)
