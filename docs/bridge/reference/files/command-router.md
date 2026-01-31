# File Reference – apps/bridge/src/services/command-router.ts

## Zweck
Zentrale Dispatch‑Logik für Commands (Relay + HTTP). Keine Self‑HTTP‑Calls, direkte Service‑Aufrufe.

## Ein-/Ausgänge
- Input: `RelayCommand`, optional `payload`
- Output: `{ success, data?, error? }`

## Abhängigkeiten
- `engine-adapter.ts`
- `device-cache.ts`
- `runtime-config.ts`
- `graphics-manager.ts`

## Side‑Effects
- Ruft Engine‑Connect/Macro‑Actions auf
- Startet/konfiguriert Graphics‑Pipeline

## Fehlerfälle
- Missing payload
- Zod‑Validation in `GraphicsManager`
