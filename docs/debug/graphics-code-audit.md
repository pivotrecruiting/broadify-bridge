# Graphics Code Audit (Ist-Stand)

## Scope

- Fokus: Graphics Pipeline (Renderer -> Composite -> Output) inkl. Pixel-Format, Colorspace, Range.
- Code: `apps/bridge/src/services/graphics/*`, `apps/bridge/native/decklink-helper/*`, `apps/bridge/src/modules/decklink/*`.
- SDK Referenzen:
  - `/Users/dennisschaible/SDKs/Blackmagic/Mac/include/DeckLinkAPIModes.h`
  - `/Users/dennisschaible/SDKs/Blackmagic/Mac/include/DeckLinkAPI.h`

## Ist-Datenfluss (Code-basiert)

1) Renderer (Electron Offscreen)
- `electron-renderer-entry.ts` nutzt `image.toBitmap()` (BGRA) und swapt zu RGBA 8-bit.
- Frame Payload (RGBA, 4 Bpp) geht via TCP IPC (localhost) mit Token-Handshake.

2) Graphics Manager
- `graphics-manager.ts` haelt letzte Frames pro Layer, compositet premultiplied RGBA.
- Fuer Outputs ohne Alpha wird nach Composite `applyBackground()` genutzt.

### Alpha Handling (Explizit)

- Renderer + Composite arbeiten mit **premultiplied RGBA**.
- `key_fill_split_sdi` un-premultipliziert RGB vor dem Split (Fill = RGB, Key = Alpha).
- `key_fill_sdi` sendet premultiplied RGBA direkt an den Helper (kein Un‑Premultiply).

3) Output Adapter
- `video_sdi` / `video_hdmi` -> `DecklinkVideoOutputAdapter` -> DeckLink Helper.
- `key_fill_sdi` -> `DecklinkKeyFillOutputAdapter` -> DeckLink Helper.
- `key_fill_ndi` -> Stub Output (kein NDI).

4) DeckLink Helper (native)
- Erwartet RGBA 8-bit (width * height * 4).
- Waehlt Pixel-Format aus Priority:
  - Video: `10bit_yuv` (v210), `8bit_yuv` (2vuy).
  - Key/Fill: `8bit_argb`, `8bit_bgra`.
- Wenn YUV: RGBA -> BGRA -> `IDeckLinkVideoConversion::ConvertNewFrame` nach YUV.
- Colorspace kommt aus DisplayMode Flags (Rec601/709/2020).
- RGB Range ist konfigurierbar (`legal`/`full`).

## SDK Fakten (Referenz)

- `bmdFormat8BitYUV` ist `2vuy` (4:2:2) und `bmdFormat10BitYUV` ist `v210` (4:2:2).
- `bmdFormat10BitYUVA` beschreibt SMPTE Video Levels fuer YUV (64-940) mit voller Alpha.
- DisplayMode Flags enthalten Colorspace: Rec601 / Rec709 / Rec2020.
- `IDeckLinkVideoConversion::ConvertNewFrame` erfordert Ziel-PixelFormat + Colorspace.

## Altlasten / Bad Practices / Risiken

- [MED] Doppeltes Channel-Swapping ohne Single Source of Truth.
  - Renderer: BGRA -> RGBA, Helper: RGBA -> BGRA (vor YUV-Conversion).
  - Performance-Overhead, hoehere Fehlergefahr bei künftigen Aenderungen.
  - Code: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`,
          `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`.

- [MED] `key_fill_ndi` ist im Schema vorhanden, aber ohne Implementation.
  - Output faellt auf Stub zurueck.
  - Code: `apps/bridge/src/services/graphics/graphics-schemas.ts`,
          `apps/bridge/src/services/graphics/graphics-manager.ts`.

- [LOW] Composite erwartet premultiplied RGBA.
  - Hinweis: Bufferlaengen werden validiert, ungueltige Layer werden uebersprungen.
  - Code: `apps/bridge/src/services/graphics/composite.ts`.

## Security Hinweise (IPC / Device Zugriff)

- Renderer IPC ist lokal auf 127.0.0.1 gebunden und per Token-Handshake abgesichert.
- DeckLink Helper hat direkten Device-Zugriff. Nur Bridge darf Frames liefern.
- Template Sanitizer blockt JS/externe URLs; das reduziert Renderer-Risiken.

## Was wir haben (Ist)

- Electron Offscreen Renderer liefert RGBA 8-bit Frames.
- Template Bindings (CSS Variablen, Text, Animation) sind implementiert.
- Composite + Background-Handling fuer Outputs ohne Alpha.
- DeckLink Helper mit RGBA -> YUV Conversion via SDK (ConvertNewFrame).
- Key/Fill SDI via ARGB/BGRA + IDeckLinkKeyer.
- Output Config Persistenz (userData/graphics/graphics-output.json).
- Format-Validierung via DeckLink Helper (list-modes).
- Pixel-Format-Policy zentral in `output-format-policy.ts`.
- Range-Config fuer Legal/Full Mapping.

## Was wir nicht haben (Luecken)

- NDI Output Adapter.
