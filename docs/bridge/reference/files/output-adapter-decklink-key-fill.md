# File Reference – decklink-key-fill-output-adapter.ts

## Zweck
Output‑Adapter für externes Key/Fill (SDI A Fill + SDI B Key). Streamt RGBA‑Frames an den Helper.

## Ein-/Ausgänge
- Input: `GraphicsOutputConfigT` (output1Id=fill, output2Id=key)
- Input: `GraphicsOutputFrameT`

## Abhängigkeiten
- `decklink-helper.ts`
- `decklink-port.ts`

## Side‑Effects
- Spawnt Helper‑Prozess (`--fill-port`, `--key-port`)
- Schreibt Header + RGBA an stdin

## Fehlerfälle
- Ports nicht valid
- Helper exit vor ready
