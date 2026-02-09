# Graphics Realtime Refactor – FrameBus (Shared Memory)

## Zweck
Zero-Copy Transport von Frames zwischen Renderer und Output-Helper. Der FrameBus ersetzt den bisherigen TCP-IPC-Transport.

## API Spec
Siehe: `docs/bridge/refactor/graphics-realtime-framebus-api.md`

## Design
- Shared Memory Segment pro Session.
- Double-Buffer oder Ring-Buffer (latest-frame-wins).
- Atomics für Writer-Seq.

## Minimaler Header (Vorschlag)
- magic
- version
- width
- height
- fps
- pixelFormat
- frameSize
- slotCount
- seq (atomar)
- timestampNs pro Slot

## Writer-Algorithmus
1. Slot = seq % slotCount
2. Frame-Daten schreiben
3. Timestamp schreiben
4. seq atomar erhöhen

## Reader-Algorithmus
1. seq lesen
2. Slot bestimmen
3. Frame-Daten kopieren
4. Wenn seq unverändert bleibt, letztes Frame erneut senden

## Security
- Shared Memory Name randomisiert.
- Rechte restriktiv setzen.
- Zugriff nur vom Helper-Prozess.

## TODO
- [ ] Cross-Platform Shared-Memory Implementierung spezifizieren.
- [ ] N-API Interface definieren.
- [ ] BGRA/RGBA Entscheidung finalisieren.
