# File Reference – apps/bridge/src/services/device-cache.ts

## Zweck
Cached Device‑Detection Ergebnisse, schützt vor Overload und liefert Outputs für die UI.

## Ein-/Ausgänge
- Input: `forceRefresh` Flag und optionale Modulnamen
- Output: `DeviceDescriptorT[]`

## Abhängigkeiten
- `module-registry.ts`

## Side‑Effects
- Startet Watcher (Hotplug)
- Rate‑limit bei Refresh
- Hält Ergebnisse pro Modul; Timeout/Fehler überschreiben keinen erfolgreichen Cache
