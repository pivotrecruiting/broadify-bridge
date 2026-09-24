# Graphics Realtime Refactor – FrameBus (Shared Memory)

## Zweck
Zero-Copy Transport von Frames zwischen Renderer und Output-Helper. Der FrameBus ersetzt den bisherigen TCP-IPC-Transport.

## API Spec
Siehe: `docs/bridge/refactor/graphics-realtime-framebus-api.md`

## Design
- Shared Memory Segment pro Session.
- Ring-Buffer (latest-frame-wins); Studio nutzt standardmäßig 3 Slots, kann aber
  über `BRIDGE_FRAMEBUS_SLOT_COUNT` explizit überschrieben werden.
- Atomics für Writer-Seq.

## Lifecycle-Regel
FrameBus-Regionen werden im normalen Renderer-Lifecycle per Name
wiederverwendet. Das gilt besonders für Studio-Recovery: ein neu gestarteter
Renderer darf die Region nicht unlinken, weil laufende Output-Helper noch das
bestehende Mapping lesen. `forceRecreate` ist nur für bewusst neu angelegte
Meeting-Regionen oder als Self-Heal bei inkompatiblem Header bzw. inkompatibler
Größe erlaubt.

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

## Entscheidung Pixel-Format
- FrameBus transportiert ausschließlich RGBA8.
- BGRA ist nicht erlaubt.
- Key/Fill-Outputs werden im Helper nach ARGB8 konvertiert.

## Status (Stand heute)
- N-API Interface für macOS implementiert.

## Finalisiert
- Windows/Linux: vorerst deferred. macOS nutzt POSIX `shm_open` + `mmap` mit `0600` Rechten.
