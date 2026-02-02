# File Reference – apps/bridge/src/modules/decklink/decklink-helper.ts

## Zweck
Wrapper um den nativen DeckLink Helper: Devices/Modes listen und Device‑Events streamen.

## Ein-/Ausgänge
- Input: helper binary path, command args
- Output: JSON‑payloads (devices, modes, events)

## Abhängigkeiten
- Native binary: `apps/bridge/native/decklink-helper/*`

## Side‑Effects
- Spawnt Child‑Prozesse (`--list`, `--list-modes`, `--watch`)

## Security
- Nur lokale Ausführung, feste Args, `X_OK` check
