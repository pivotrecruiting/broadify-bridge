# File Reference – decklink-split-output-adapter.ts

## Zweck
Split‑Adapter: trennt Alpha (Key) vom Fill und sendet beide Frames an zwei Video‑Adapter.

## Ein-/Ausgänge
- Input: `GraphicsOutputFrameT`
- Output: zwei separate Frames (Fill/Key)

## Abhängigkeiten
- `decklink-video-output-adapter.ts`

## Side‑Effects
- Spawnt zwei Helper‑Prozesse (je Output)
