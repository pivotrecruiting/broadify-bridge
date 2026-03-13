# Bridge Feature – Output‑Konfiguration & Pixel‑Policy

## Zweck
Diese Doku beschreibt, wie Outputs konfiguriert, validiert und für Hardware‑Ausgabe vorbereitet werden (Ports, Formate, Pixel‑Formate, Range/Colorspace).

## Einstiegspunkte
- Command: `graphics_configure_outputs`
- Validierung/Orchestrierung: `apps/bridge/src/services/graphics/graphics-manager.ts`
- Schemas: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Target-/Format-Validierung: `apps/bridge/src/services/graphics/graphics-output-validation-service.ts`
- Output‑Policy: `apps/bridge/src/services/graphics/output-format-policy.ts`
- Port‑Parsing: `apps/bridge/src/services/graphics/output-adapters/decklink-port.ts`
- Device‑Detection: `apps/bridge/src/services/device-cache.ts`, `apps/bridge/src/modules/decklink/*`

## Payload (Beispiel)
```json
{
  "version": 1,
  "outputKey": "key_fill_sdi",
  "targets": {
    "output1Id": "<device>-sdi-a",
    "output2Id": "<device>-sdi-b"
  },
  "format": { "width": 1920, "height": 1080, "fps": 50 },
  "range": "legal",
  "colorspace": "auto"
}
```

## Output‑Key Regeln
- `key_fill_sdi`
  - Output1/Output2 erforderlich
  - Beide SDI, gleicher Device
  - Output1 = Fill, Output2 = Key
- `video_sdi`
  - Output1 erforderlich
  - SDI‑Port, **kein** Key‑Port
- `video_hdmi`
  - Output1 erforderlich
  - HDMI/DisplayPort/Thunderbolt‑Port
- `key_fill_ndi`
  - NDI Streamname optional (derzeit nicht validiert)
  - Output‑Adapter ist aktuell Stub (NDI nicht implementiert)
- `stub`
  - Keine Targets erforderlich

## Format‑Validierung
Validierung erfolgt über `validateOutputFormat` in `graphics-output-validation-service.ts`:
- Für DeckLink‑Outputs wird der Helper nach Display‑Modes abgefragt
- Für Display‑Outputs werden Port‑Modes aus der Device-Detection geprüft
- `requireKeying` wird gesetzt, wenn Key/Fill genutzt wird
- Pixel‑Formate werden gegen die Policy geprüft
- In Development‑Mode wird Validierung übersprungen (Stub‑Output)

### Pixel‑Policy
- Video: `VIDEO_PIXEL_FORMAT_PRIORITY = ["10bit_yuv", "8bit_yuv"]`
- Key/Fill: `KEY_FILL_PIXEL_FORMAT_PRIORITY = ["8bit_argb", "8bit_bgra"]`

## Range & Colorspace
- `range` und `colorspace` werden an den DeckLink Helper übergeben
- Stub‑Output ignoriert diese Felder

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant CR as CommandRouter
  participant GM as GraphicsManager
  participant DC as DeviceCache
  participant DH as DeckLink Helper

  CR->>GM: configureOutputs(payload)
  GM->>GM: validateOutputTargets
  GM->>DC: getDevices()
  GM->>DH: list display modes
  GM->>GM: validateOutputFormat
  GM-->>CR: success
```

## Fehlerbilder
- Ports nicht verfügbar → Validation Error
- Format nicht unterstützt → Validation Error
- Helper nicht verfügbar → leerer Mode‑List → Validation Error
- Port‑IDs ungültig → parseDecklinkPortId() Fehler

## Relevante Dateien
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-schemas.ts`
- `apps/bridge/src/services/graphics/output-format-policy.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-port.ts`
- `apps/bridge/src/modules/decklink/decklink-helper.ts`
