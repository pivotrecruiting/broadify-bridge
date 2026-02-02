# File Reference – apps/bridge/src/modules/module-registry.ts

## Zweck
Koordiniert Device‑Module, führt parallele Detection mit Timeout aus und merged Ergebnisse.

## Ein-/Ausgänge
- Input: Device‑Module (register)
- Output: `DeviceDescriptorT[]`

## Abhängigkeiten
- `device-module.ts`

## Side‑Effects
- Optional: Watcher‑Subscription
