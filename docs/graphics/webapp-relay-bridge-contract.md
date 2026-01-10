# WebApp -> Relay -> Bridge Command Contract

## Ziel

Diese Dokumentation beschreibt, welche Commands die WebApp an den Relay Server sendet und welche Daten die Bridge empfaengt, verarbeitet und beantwortet.

## Transport-Flow

1. WebApp sendet `POST /api/bridges/[bridgeId]/command`.
2. Next.js leitet an `POST /relay/command` weiter (Relay Server).
3. Relay sendet WebSocket `command` an die Bridge.
4. Bridge antwortet mit `command_result`.
5. Relay antwortet mit HTTP 200 und `{ success, data, error }`.

### Request Format (WebApp -> Relay)

```json
{
  "bridgeId": "string",
  "command": "string",
  "payload": {}
}
```

### Response Format (Relay -> WebApp)

```json
{
  "success": true,
  "data": {}
}
```

oder

```json
{
  "success": false,
  "error": "string"
}
```

## Command Katalog

### Core

- `get_status` -> `{}`

  - Bridge gibt Statusdaten zurueck (version, uptime, state, outputsConfigured).

- `list_outputs` -> `{}`
  - Bridge liefert Output-Listen (output1, output2).

### Engine

- `engine_connect` -> `{ type, ip, port }`
- `engine_disconnect` -> `{}`
- `engine_get_status` -> `{}`
- `engine_get_macros` -> `{}`
- `engine_run_macro` -> `{ macroId }`
- `engine_stop_macro` -> `{ macroId }`

### Graphics

#### `graphics_configure_outputs`

Payload:

```json
{
  "outputKey": "stub",
  "targets": {
    "output1Id": "string?",
    "output2Id": "string?",
    "ndiStreamName": "string?"
  },
  "format": { "width": 1920, "height": 1080, "fps": 50 }
}
```

Regeln:

- Aktuell wird nur `stub` als outputKey unterstützt (keine echte Ausgabe).
- Format wird von der WebApp fix auf `1920x1080 @ 50fps` gesetzt.

Bridge-Verhalten:

- Konfiguration validieren.
- Output-Pipeline entsprechend setzen.
- Bei Fehler `{ success: false, error }` senden.

#### `graphics_send`

Payload:

```json
{
  "layerId": "string",
  "category": "lower-thirds" | "overlays" | "slides",
  "backgroundMode": "transparent" | "green" | "black" | "white",
  "layout": { "x": 0, "y": 0, "scale": 1 },
  "zIndex": 30,
  "bundle": {
    "manifest": {},
    "html": "string",
    "css": "string",
    "schema": {},
    "defaults": {},
    "assets": [
      { "assetId": "string", "name": "string", "mime": "string", "data": "base64?" }
    ]
  },
  "values": { "key": "value" }
}
```

Regeln:

- Templates enthalten kein eigenes JavaScript.
- Keine externen URLs; Assets werden ueber `asset://<assetId>` referenziert.
- Assets koennen optional als Base64 (`data`) geliefert und in der Bridge gespeichert werden.
- Bei Output-Keys mit Alpha-Unterstützung soll `backgroundMode` als `transparent` behandelt werden.

Bridge-Verhalten:

- Bundle validieren und rendern.
- RGBA-Frames erzeugen und in Composite integrieren.
- Output-Transformation nach `outputKey` ausfuehren.

#### `graphics_update_values`

Payload:

```json
{ "layerId": "string", "values": { "key": "value" } }
```

Bridge-Verhalten:

- Werte ohne Full-Reload anwenden.

#### `graphics_update_layout`

Payload:

```json
{ "layerId": "string", "layout": { "x": 0, "y": 0, "scale": 1 }, "zIndex": 30 }
```

Bridge-Verhalten:

- Layout und Z-Order aktualisieren.

#### `graphics_remove`

Payload:

```json
{ "layerId": "string" }
```

Bridge-Verhalten:

- Layer aus Registry entfernen und aus Composite entfernen.

#### `graphics_list`

Payload:

```json
{}
```

Empfohlene Response-Daten:

```json
{
  "outputConfig": {
    "outputKey": "stub",
    "targets": { "output1Id": "sdi-1", "output2Id": "sdi-2" },
    "format": { "width": 1920, "height": 1080, "fps": 50 }
  },
  "layers": [
    {
      "layerId": "lower-thirds-...",
      "category": "lower-thirds",
      "layout": { "x": 0, "y": 780, "scale": 1 },
      "zIndex": 30
    }
  ]
}
```

## Response Regeln

- Jeder Command beantwortet `{ success, data, error }`.
- Fehler werden als klarer String gemeldet.
- Relay gibt immer HTTP 200, der Status steht im Body.
