# File Reference – apps/bridge/src/modules/decklink/index.ts

## Zweck
Registriert DeckLink‑Detection und Watcher‑Events. Liefert Controller für DeckLink‑Devices.

## Ein-/Ausgänge
- Input: Watcher‑Events vom Helper
- Output: `DeviceDescriptorT[]`

## Abhängigkeiten
- `decklink-detector.ts`
- `decklink-helper.ts`
- `decklink-device.ts`

## Side‑Effects
- Startet Device‑Watcher (Helper‑Process)
