# Graphics Command Examples

## command_result (Success)

```json
{
  "type": "command_result",
  "requestId": "uuid",
  "success": true,
  "data": {}
}
```

## command_result (Error)

```json
{
  "type": "command_result",
  "requestId": "uuid",
  "success": false,
  "error": "Output 1 and Output 2 are required for Key & Fill SDI."
}
```

## graphics_configure_outputs

```json
{
  "command": "graphics_configure_outputs",
  "payload": {
    "outputKey": "key_fill_sdi",
    "targets": {
      "output1Id": "decklink-<device-id>-sdi-a",
      "output2Id": "decklink-<device-id>-sdi-b"
    },
    "format": {
      "width": 1920,
      "height": 1080,
      "fps": 50
    }
  }
}
```

Hinweis: `fps` entspricht der gewaehlten Display-Mode-FPS.

## graphics_send

```json
{
  "command": "graphics_send",
  "payload": {
    "layerId": "lower-thirds-abc-1704456000",
    "category": "lower-thirds",
    "backgroundMode": "transparent",
    "layout": { "x": 0, "y": 780, "scale": 1 },
    "zIndex": 30,
    "bundle": {
      "manifest": { "render": { "width": 1920, "height": 1080, "fps": 50 } },
      "html": "<div data-root=\"graphic\" class=\"root\"></div>",
      "css": ".root{position:relative}",
      "schema": {},
      "defaults": {}
    },
    "values": { "title": "Example" }
  }
}
```

## graphics_update_values

```json
{
  "command": "graphics_update_values",
  "payload": {
    "layerId": "lower-thirds-abc-1704456000",
    "values": { "title": "Updated" }
  }
}
```

## graphics_update_layout

```json
{
  "command": "graphics_update_layout",
  "payload": {
    "layerId": "lower-thirds-abc-1704456000",
    "layout": { "x": 120, "y": 760, "scale": 1 },
    "zIndex": 30
  }
}
```

## graphics_remove

```json
{
  "command": "graphics_remove",
  "payload": { "layerId": "lower-thirds-abc-1704456000" }
}
```

## graphics_remove_preset

```json
{
  "command": "graphics_remove_preset",
  "payload": { "presetId": "preset-123", "clearQueue": true }
}
```

## graphics_list (Response Data)

```json
{
  "outputConfig": {
    "outputKey": "key_fill_sdi",
    "targets": {
      "output1Id": "decklink-<device-id>-sdi-a",
      "output2Id": "decklink-<device-id>-sdi-b"
    },
    "format": { "width": 1920, "height": 1080, "fps": 50 }
  },
  "layers": [
    {
      "layerId": "lower-thirds-abc-1704456000",
      "category": "lower-thirds",
      "layout": { "x": 0, "y": 780, "scale": 1 },
      "zIndex": 30
    }
  ],
  "activePreset": {
    "presetId": "string",
    "durationMs": 10000,
    "startedAt": 0,
    "expiresAt": 0,
    "pendingStart": false,
    "layerIds": ["lower-thirds-abc-1704456000"]
  },
  "queuedPresets": [
    {
      "presetId": "string",
      "durationMs": 10000,
      "layerIds": ["lower-thirds-abc-1704456000"],
      "enqueuedAt": 0
    }
  ]
}
```
