# File Reference – decklink-video-output-adapter.ts

## Zweck
Output‑Adapter für ein einzelnes Video‑Output (ohne Key/Fill). Startet den
DeckLink Helper, der Frames aus dem FrameBus liest.

## Ein-/Ausgänge
- Input: `GraphicsOutputConfigT` (output1Id)
- Input: `GraphicsOutputFrameT`

## Abhängigkeiten
- `decklink-helper.ts` (binary path)
- `decklink-port.ts` (port parsing)

## Side‑Effects
- Spawnt Helper‑Prozess (`--playback`)
- Uebergibt FrameBus-Konfiguration per Args/Env
- Schreibt nur den Shutdown-Header an stdin
- Meldet unerwartete Helper-Exits nach `ready` ueber `onLifecycle`

## Fehlerfälle
- Helper fehlt oder nicht executable
- Port‑ID ungültig
- Helper exit vor ready oder Ready-Timeout
- Helper exit nach ready → `output_helper_error`/Supervisor-Recovery
