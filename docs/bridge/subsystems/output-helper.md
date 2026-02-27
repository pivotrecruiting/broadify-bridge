# Bridge Subsystem – Output Adapter & Helper

## Zweck
Dieses Subsystem liefert gerenderte Frames an die jeweilige Ausgabe. Die Data-Plane ist FrameBus (Shared Memory). Je nach Output-Modus werden passende native Helper genutzt.

## Verantwortlichkeiten
- Auswahl des Output‑Adapters (Key/Fill, Video, Display, Stub)
- Start/Stop von Helper‑Prozessen
- FrameBus-basierter Output für DeckLink und Display
- Validierung von Port‑IDs und Output‑Konfiguration
- Handshake + Diagnostics für Display‑Output Helper

## Hauptkomponenten
- Adapter Interface: `apps/bridge/src/services/graphics/output-adapter.ts`
- DeckLink Video: `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`
- DeckLink Key/Fill: `apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts`
- Display Output: `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- Stub: `apps/bridge/src/services/graphics/output-adapters/stub-output-adapter.ts`
- Helper Resolve: `apps/bridge/src/modules/decklink/decklink-helper.ts`
- Display Helper Resolve: `apps/bridge/src/modules/display/display-helper.ts`
- Native Display Helper (macOS/Windows): `apps/bridge/native/display-helper/src/display-helper.cpp`

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant GM as GraphicsManager
  participant OA as OutputAdapter
  participant FB as FrameBus
  participant DH as DeckLink Helper
  participant EH as Display Helper (native)

  GM->>OA: configure/start
  alt DeckLink Output
    OA->>FB: read RGBA frames
    OA->>DH: configure/start output session
    DH-->>OA: ready/logs
  else Display Output
    OA->>EH: spawn + args/env (FrameBus params)
    EH->>FB: read RGBA frames
    EH-->>OA: ready/logs
  end
```

## Plattformstatus (Display Output)
- **macOS:** Unterstützt (nativer `display-helper`, SDL2, FrameBus)
- **Windows:** Unterstützt (nativer `display-helper.exe`, SDL2, FrameBus)
- **Linux:** Nicht implementiert

## Security‑Hinweise
- Helper‑Binary wird per Pfad‑Check validiert (`X_OK` auf POSIX, `F_OK` auf Windows).
- Keine Shell‑Execution; feste Argumente.
- Frame‑Payloads sind lokal und nicht extern exponiert.
- Display‑Helper nutzt festen Binary-Pfad (Override via `BRIDGE_DISPLAY_HELPER_PATH`) und whitelisted Env‑Variablen.
- `key_fill_ndi` hat aktuell keinen nativen Adapterpfad und landet im Stub-Adapter.

## Fehlerbilder
- Helper nicht vorhanden/kein Execute‑Bit → configure() Fehler
- Port‑ID ungültig → parseDecklinkPortId() Fehler
- Helper exit vor Ready → configure() schlägt fehl
- Display‑Output auf nicht unterstützter Plattform → `Display output is only supported on macOS and Windows`
- Display‑Helper fehlt/nicht ausführbar → configure() Fehler
- `BRIDGE_FRAMEBUS_NAME` fehlt → configure() Fehler

## Relevante Dateien
- `apps/bridge/src/services/graphics/output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/*`
- `apps/bridge/src/modules/decklink/decklink-helper.ts`
- `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`
- `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- `apps/bridge/src/modules/display/display-helper.ts`
- `apps/bridge/native/display-helper/src/display-helper.cpp`
