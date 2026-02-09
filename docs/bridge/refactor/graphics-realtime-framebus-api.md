# Graphics Realtime Refactor – FrameBus API (Spec)

## Zweck
Definiert die API und Speicherstruktur für den Shared-Memory FrameBus. Ziel ist Zero-Copy Frame-Transport zwischen Renderer und Output-Helper.

## SSOT Referenzen
- Output-Format Payload: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Output-Policy (Pixel-Formate): `apps/bridge/src/services/graphics/output-format-policy.ts`

## Naming & Versioning
- FrameBus hat eine `version` im Header.
- `magic` dient zur Validierung (z. B. `BRGF`).

## Shared Memory Layout (Vorschlag)
### Header (fixed size)
- `magic: u32`
- `version: u16`
- `flags: u16`
- `width: u32`
- `height: u32`
- `fps: u32`
- `pixelFormat: u32` (enum)
- `frameSize: u32`
- `slotCount: u32`
- `seq: u64` (atomic, monoton)
- `lastWriteNs: u64`
- `reserved[64]`

### Slots (variable)
- `slot[0..slotCount-1]`: raw frame bytes
- Optional pro Slot: `slotTimestampNs[]`

## Writer-API (Renderer)
- `framebus.create(name, size, header)`
- `framebus.write(frameBuffer, timestampNs)`
- `framebus.close()`

## Reader-API (Output-Helper)
- `framebus.open(name)`
- `framebus.readLatest()` -> { buffer, timestampNs, seq }
- `framebus.close()`

## Concurrency Regeln
- Single Writer, Single Reader.
- Latest-frame-wins; keine FIFO-Garantien.

## Pixel-Format
- FrameBus transportiert RGBA, wie aktuell im Renderer/Bridge-Flow.
- Pixel-Format-Prioritäten bleiben exakt wie implementiert:
  - Video: `VIDEO_PIXEL_FORMAT_PRIORITY = ["10bit_yuv", "8bit_yuv"]`
  - Key/Fill: `KEY_FILL_PIXEL_FORMAT_PRIORITY = ["8bit_argb", "8bit_bgra"]`
  Quelle: `apps/bridge/src/services/graphics/output-format-policy.ts`

## TODO
- [ ] Header-Felder final definieren.
- [ ] PixelFormat Enum festlegen.
- [ ] N-API Signaturen definieren.
- [ ] OS-spezifische Shared-Memory Implementierung festlegen.
