# File Reference – decklink-key-fill-output-adapter.ts

## Zweck
Output‑Adapter für externes Key/Fill (SDI A Fill + SDI B Key). Startet den
DeckLink Helper, der Frames aus dem FrameBus liest.

## Ein-/Ausgänge
- Input: `GraphicsOutputConfigT` (output1Id=fill, output2Id=key)
- Input: `GraphicsOutputFrameT`

## Abhängigkeiten
- `decklink-helper.ts`
- `decklink-port.ts`

## Side‑Effects
- Spawnt Helper‑Prozess (`--fill-port`, `--key-port`)
- Uebergibt FrameBus-Konfiguration per Args/Env
- Schreibt nur den Shutdown-Header an stdin
- Meldet unerwartete Helper-Exits nach `ready` ueber `onLifecycle`

## Fehlerfälle
- Ports nicht valid
- Helper exit vor ready oder Ready-Timeout
- Helper exit nach ready → `output_helper_error`/Supervisor-Recovery
