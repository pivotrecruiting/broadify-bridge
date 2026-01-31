# File Reference – apps/bridge/native/decklink-helper/src/decklink-helper.cpp

## Zweck
Native DeckLink Helper (macOS). Listet Devices/Modes, streamt Watch‑Events und übernimmt Playback‑Output.

## Ein-/Ausgänge
- Input: CLI‑Flags (`--list`, `--watch`, `--list-modes`, `--playback`, etc.)
- Output: JSON über stdout (Devices/Modes/Events)
- Input (Playback): RGBA‑Frames via stdin

## Abhängigkeiten
- Blackmagic DeckLink SDK

## Side‑Effects
- Zugriff auf DeckLink Hardware
- Lang laufende Watch/Playback Prozesse
