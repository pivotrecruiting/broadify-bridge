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
- Frame Payload (RGBA, 4 Bpp) geht via TCP IPC (localhost) und zusätzlich via process IPC.

2) Graphics Manager
- `graphics-manager.ts` haelt letzte Frames pro Layer, compositet premultiplied RGBA.
- Fuer Outputs ohne Alpha wird nach Composite `applyBackground()` genutzt.

3) Output Adapter
- `video_sdi` / `video_hdmi` -> `DecklinkVideoOutputAdapter` -> DeckLink Helper.
- `key_fill_sdi` -> `DecklinkKeyFillOutputAdapter` -> DeckLink Helper.
- `key_fill_ndi` -> Stub Output (kein NDI).

4) DeckLink Helper (native)
- Erwartet RGBA 8-bit (width * height * 4).
- Waehlt Pixel-Format aus Priority:
  - Video: `10bit_yuv` (v210) only.
  - Key/Fill: `8bit_argb`, `8bit_bgra`.
- Wenn YUV: RGBA -> BGRA -> `IDeckLinkVideoConversion::ConvertNewFrame` nach YUV.
- Colorspace kommt aus DisplayMode Flags (Rec601/709/2020).
- RGB wird immer auf Legal Range (16-235) gemappt.

## SDK Fakten (Referenz)

- `bmdFormat8BitYUV` ist `2vuy` (4:2:2) und `bmdFormat10BitYUV` ist `v210` (4:2:2).
- `bmdFormat10BitYUVA` beschreibt SMPTE Video Levels fuer YUV (64-940) mit voller Alpha.
- DisplayMode Flags enthalten Colorspace: Rec601 / Rec709 / Rec2020.
- `IDeckLinkVideoConversion::ConvertNewFrame` erfordert Ziel-PixelFormat + Colorspace.

## Altlasten / Bad Practices / Risiken

- [HIGH] Video Output ist hart auf `10bit_yuv` festgelegt und nutzt `bmdNoVideoOutputConversion`.
  - Kein Fallback auf `8bit_yuv` oder RGB, obwohl Code-Comment existiert.
  - Risiko: Output faellt bei Modi/Geraeten ohne v210 Support.
  - Code: `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`,
          `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`.

- [HIGH] Colorspace wird nur ueber DisplayMode Flags ermittelt; bei `unknown` wird Output abgebrochen.
  - Kein Fallback (z.B. Rec709 fuer HD, Rec601 fuer SD), kein Override im Config.
  - Code: `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`.

- [MED] Legal Range Mapping ist global aktiv und nicht konfigurierbar.
  - RGB wird fuer alle Outputs geklemmt (auch ARGB/BGRA Key/Fill).
  - Risiko: unklare Levels, moegliche Doppel-Range-Kompression.
  - Code: `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`.

- [MED] Doppeltes Channel-Swapping ohne Single Source of Truth.
  - Renderer: BGRA -> RGBA, Helper: RGBA -> BGRA (vor YUV-Conversion).
  - Performance-Overhead, hoehere Fehlergefahr bei künftigen Aenderungen.
  - Code: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`,
          `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`.

- [MED] `validateOutputFormat()` ist Placeholder.
  - Unsupported width/height/fps werden nicht vorab validiert.
  - Risiko: Fehler erst im Helper/Device.
  - Code: `apps/bridge/src/services/graphics/graphics-manager.ts`.

- [MED] `key_fill_ndi` ist im Schema vorhanden, aber ohne Implementation.
  - Output faellt auf Stub zurueck.
  - Code: `apps/bridge/src/services/graphics/graphics-schemas.ts`,
          `apps/bridge/src/services/graphics/graphics-manager.ts`.

- [LOW] Composite geht von premultiplied RGBA aus, validiert aber Bufferlaenge nicht.
  - Risiko: undefiniertes Verhalten bei falscher Bufferlaenge.
  - Code: `apps/bridge/src/services/graphics/composite.ts`.

- [LOW] Zwei parallele Frame-Transportwege (TCP + process IPC).
  - Risiko: doppelte Frames / Logging-Overhead / uneindeutiger Datenfluss.
  - Code: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`,
          `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`.

## Security Hinweise (IPC / Device Zugriff)

- Renderer IPC ist lokal auf 127.0.0.1 gebunden. Das ist gut, aber es gibt keine Auth.
- DeckLink Helper hat direkten Device-Zugriff. Nur Bridge darf Frames liefern.
- Template Sanitizer blockt JS/externe URLs; das reduziert Renderer-Risiken.

## Was wir haben (Ist)

- Electron Offscreen Renderer liefert RGBA 8-bit Frames.
- Template Bindings (CSS Variablen, Text, Animation) sind implementiert.
- Composite + Background-Handling fuer Outputs ohne Alpha.
- DeckLink Helper mit RGBA -> YUV Conversion via SDK (ConvertNewFrame).
- Key/Fill SDI via ARGB/BGRA + IDeckLinkKeyer.
- Output Config Persistenz (userData/graphics/graphics-output.json).

## Was wir nicht haben (Luecken)

- NDI Output Adapter.
- Format-Validierung gegen DeckLink Display Modes.
- Konfigurierbarer Pixel-Format/Colorspace/Range als Single Source of Truth.
- Explizite Doku, ob Daten premultiplied oder straight alpha sind.
