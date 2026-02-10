# Graphics Realtime Refactor – FrameBus API (Spec)

## Zweck
Definiert die API und Speicherstruktur für den Shared-Memory FrameBus. Ziel ist Zero-Copy Frame-Transport zwischen Renderer und Output-Helper.

## SSOT Referenzen
- Output-Format Payload: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Output-Policy (Pixel-Formate): `apps/bridge/src/services/graphics/output-format-policy.ts`
- C/C++ Header Spec: `docs/bridge/refactor/graphics-realtime-framebus-c-header.md`
- N-API Spec: `docs/bridge/refactor/graphics-realtime-framebus-napi-api.md`

## Naming & Versioning
- FrameBus hat eine `version` im Header.
- `magic` dient zur Validierung (z. B. `BRGF`).

## Shared Memory Layout (Vorschlag)
### Endianness
- Alle Integer sind **Little Endian**.

### Header (fixed size = 128 bytes)
| Offset | Size | Type | Name | Beschreibung |
| --- | --- | --- | --- | --- |
| 0 | 4 | u32 | magic | ASCII `BRGF` |
| 4 | 2 | u16 | version | Header-Version |
| 6 | 2 | u16 | flags | Reserviert |
| 8 | 4 | u32 | headerSize | Muss 128 sein |
| 12 | 4 | u32 | width | Frame-Width |
| 16 | 4 | u32 | height | Frame-Height |
| 20 | 4 | u32 | fps | Ziel-FPS |
| 24 | 4 | u32 | pixelFormat | enum, siehe unten |
| 28 | 4 | u32 | frameSize | width * height * 4 |
| 32 | 4 | u32 | slotCount | z. B. 2 |
| 36 | 4 | u32 | slotStride | i. d. R. = frameSize |
| 40 | 8 | u64 | seq | Atomic, monoton |
| 48 | 8 | u64 | lastWriteNs | Monotonic Timestamp |
| 56 | 72 | bytes | reserved | Zukünftige Felder |

### Slots (variable)
- `slot[0..slotCount-1]`: raw frame bytes
- Optional pro Slot: `slotTimestampNs[]`

## Writer-API (Renderer)
- Renderer nutzt N-API `createWriter()`; `framebusSize` bestimmt SlotCount (Header 128 + FrameSize * N).
- `writeFrame(buffer, timestampNs)` schreibt das aktuellste Frame (latest-frame-wins).

## Reader-API (Output-Helper)
- `openReader(name)`
- `framebus.readLatest()` -> { buffer, timestampNs, seq }
- `framebus.close()`

## Concurrency Regeln
- Single Writer, Single Reader.
- Latest-frame-wins; keine FIFO-Garantien.

## Pixel-Format
- FrameBus transportiert RGBA, wie aktuell im Renderer/Bridge-Flow.
- Pixel-Format-Prioritäten bleiben exakt wie implementiert:
  - Video: `VIDEO_PIXEL_FORMAT_PRIORITY = ["10bit_yuv", "8bit_yuv"]`
  - Key/Fill: `KEY_FILL_PIXEL_FORMAT_PRIORITY = ["8bit_argb"]` (ARGB8-only, kein BGRA-Fallback)
- Quelle: `apps/bridge/src/services/graphics/output-format-policy.ts`
- Key/Fill-Outputs werden im Helper von RGBA8 nach ARGB8 konvertiert.

### PixelFormat Enum (FrameBus)
- `1 = RGBA8` (aktuell, verpflichtend)
- `2 = BGRA8` (reserved, derzeit nicht genutzt)
- `3 = ARGB8` (reserved, derzeit nicht genutzt)

## Memory Size
- `totalSize = headerSize + slotStride * slotCount`

## Status (Stand heute)
- Header-Layout implementiert (C++ Header + N-API).
- PixelFormat Enum in Code gespiegelt.
- N-API Signaturen definiert.

## Finalisiert
- macOS: POSIX `shm_open` + `mmap` (0600). Windows/Linux deferred.
