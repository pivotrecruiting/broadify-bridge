# Bridge Feature – Graphics Commands & Payloads

## Zweck
Diese Doku beschreibt die Graphics‑Commands (`graphics_*`), deren Payload‑Schemas, Validierung und Laufzeit‑Verhalten.

## Einstiegspunkte
- Relay: `apps/bridge/src/services/relay-client.ts`
- Command Router: `apps/bridge/src/services/command-router.ts`
- Schemas: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Orchestrierung: `apps/bridge/src/services/graphics/graphics-manager.ts`

## Command‑Envelope (Relay)
Relay liefert eine Message vom Typ `command`:
```json
{
  "type": "command",
  "requestId": "<uuid>",
  "command": "graphics_send",
  "payload": { ... }
}
```
Antwort:
```json
{
  "type": "command_result",
  "requestId": "<uuid>",
  "success": true,
  "data": {}
}
```

## Commands – Übersicht
- `graphics_configure_outputs`
- `graphics_send`
- `graphics_update_values`
- `graphics_update_layout`
- `graphics_remove`
- `graphics_remove_preset`
- `graphics_test_pattern`
- `graphics_list`

## 1) graphics_configure_outputs
Schema: `GraphicsConfigureOutputsSchema`

**Payload (Beispiel)**
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

**Validierung / Regeln**
- `outputKey` bestimmt Pflicht‑Targets und Port‑Rollen.
- `key_fill_sdi`: Output1=Fill, Output2=Key, beide SDI, gleiche Device.
- `key_fill_split_sdi`: zwei SDI‑Ports, aber **keine** Key‑Port‑Rolle.
- `video_sdi`: ein SDI‑Port, **nicht** Key.
- `video_hdmi`: ein HDMI‑Port.
- `key_fill_ndi` & `stub`: keine zusätzliche Port‑Validierung.
- `format` wird gegen unterstützte Display‑Modes geprüft (DeckLink Helper).

## 2) graphics_send
Schema: `GraphicsSendSchema`

**Payload (Beispiel)**
```json
{
  "layerId": "lower-third-1",
  "category": "lower-thirds",
  "backgroundMode": "transparent",
  "layout": { "x": 0, "y": 780, "scale": 1 },
  "zIndex": 30,
  "bundle": {
    "manifest": { "render": { "width": 1920, "height": 1080, "fps": 50 } },
    "html": "<div data-root=\"graphic\">{{title}}</div>",
    "css": ".root{color:white;font-size:64px;}",
    "schema": {},
    "defaults": { "title": "Hello" },
    "assets": []
  },
  "values": { "title": "Breaking News" },
  "presetId": "package-1",
  "durationMs": 5000
}
```

**Validierung / Regeln**
- `durationMs` erfordert `presetId`.
- Wenn `manifest.render` gesetzt ist, muss es Output‑Format matchen.
- HTML/CSS wird gesäubert und gegen gefährliche Inhalte geprüft.
- Assets müssen im Bundle enthalten oder bereits registriert sein.
- Bei Outputs mit Alpha wird `backgroundMode` erzwungen auf `transparent`.

## 3) graphics_update_values
Schema: `GraphicsUpdateValuesSchema`

**Payload**
```json
{ "layerId": "lower-third-1", "values": { "title": "Update" } }
```

**Verhalten**
- Merged Werte in den Layer‑State.
- Aktualisiert Bindings und triggert Renderer‑Update.

## 4) graphics_update_layout
Schema: `GraphicsUpdateLayoutSchema`

**Payload**
```json
{ "layerId": "lower-third-1", "layout": { "x": 0, "y": 700, "scale": 1 }, "zIndex": 40 }
```

**Verhalten**
- Aktualisiert Layout (Transform) und optional `zIndex`.

## 5) graphics_remove
Schema: `GraphicsRemoveSchema`

**Payload**
```json
{ "layerId": "lower-third-1" }
```

**Verhalten**
- Entfernt Layer aus Renderer und State.

## 6) graphics_remove_preset
Schema: `GraphicsRemovePresetSchema`

**Payload**
```json
{ "presetId": "package-1", "clearQueue": true }
```

**Verhalten**
- Entfernt alle Layer dieses Presets.
- Optional: Preset‑Queue komplett leeren.

## 7) graphics_test_pattern
**Payload:** none

**Verhalten**
- Entfernt alle Layer.
- Sendet Test‑Pattern‑Layer.

## 8) graphics_list
**Payload:** none

**Antwort** (Auszug)
```json
{
  "outputConfig": { ... },
  "layers": [ { "layerId": "...", "category": "...", "layout": { ... }, "zIndex": 30 } ],
  "activePreset": { "presetId": "...", "durationMs": 5000, "layerIds": ["..."] },
  "queuedPresets": [ { "presetId": "...", "durationMs": 5000, "layerIds": ["..."] } ]
}
```

## Sicherheitsregeln (Templates)
- Keine `<script>` Tags, Inline‑Events, externe URLs oder `@import`.
- Nur `asset://<assetId>` für lokale Assets.
- CSS‑Kommentare werden vor Validation entfernt.

## Relevante Dateien
- `apps/bridge/src/services/relay-client.ts`
- `apps/bridge/src/services/command-router.ts`
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-schemas.ts`
- `apps/bridge/src/services/graphics/template-sanitizer.ts`
- `apps/bridge/src/services/graphics/asset-registry.ts`
