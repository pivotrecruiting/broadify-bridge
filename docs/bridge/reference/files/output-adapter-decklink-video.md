# File Reference – decklink-video-output-adapter.ts

## Zweck
Output‑Adapter für ein einzelnes Video‑Output (ohne Key/Fill). Streamt RGBA‑Frames an den DeckLink Helper.

## Ein-/Ausgänge
- Input: `GraphicsOutputConfigT` (output1Id)
- Input: `GraphicsOutputFrameT`

## Abhängigkeiten
- `decklink-helper.ts` (binary path)
- `decklink-port.ts` (port parsing)

## Side‑Effects
- Spawnt Helper‑Prozess (`--playback`)
- Schreibt Header + RGBA an stdin

## Fehlerfälle
- Helper fehlt oder nicht executable
- Port‑ID ungültig
