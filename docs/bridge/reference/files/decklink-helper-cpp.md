# File Reference – apps/bridge/native/decklink-helper/src/decklink-helper.cpp

## Zweck
Native DeckLink Helper (macOS). Listet Devices/Modes, streamt Watch‑Events und übernimmt Playback‑Output.

## Ein-/Ausgänge
- Input: CLI‑Flags (`--list`, `--list --with-diagnostics`, `--watch`,
  `--list-modes`, `--playback`, `--version`, etc.)
- Output: JSON über stdout (Devices/Modes/Events)
- Input (Playback): FrameBus-Name/Geometrie via Args/Env; stdin nur fuer
  Shutdown-Header
- Playback-Flags: `--display-mode <id>` bevorzugt einen exakten DeckLink SDK
  Display-Mode; bei nicht nutzbarer ID faellt der Helper mit
  `warning.display_mode_id_not_found` auf die Heuristik zurueck.

## Abhängigkeiten
- Blackmagic DeckLink SDK

## Side‑Effects
- Zugriff auf DeckLink Hardware
- Lang laufende Watch/Playback Prozesse
- Playback sendet `ready` mit `helperVersion` auf stdout. Nach erfolgreichem
  `StartScheduledPlayback` folgt `playback_started`; Start-/Laufzeitfehler
  senden `fatal` mit stabilem Code und optionalem HRESULT.
- Der FrameBus-Reader erkennt stale `seq`-Fortschritte, oeffnet die Region nach
  2s neu und verwirft potentiell torn Slot-Kopien. `metrics` enthaelt
  `tornFrames`.
- `--watch` ohne DeckLink-Discovery sendet `fatal api_unavailable` und beendet
  sich mit Exit-Code 2.
