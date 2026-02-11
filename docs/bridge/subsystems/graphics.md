# Bridge Subsystem – Graphics Pipeline

## Zweck
Dieses Subsystem rendert Graphics‑Layer (HTML/CSS) zu RGBA‑Frames und liefert sie an Hardware‑Outputs (z. B. DeckLink SDI/HDMI). Es orchestriert Assets, Layouts, Presets und Output‑Konfiguration.

## Verantwortlichkeiten
- Validierung und Sanitizing von Graphics‑Payloads
- Rendering über separaten Electron‑Offscreen‑Prozess
- Layer‑Compositing, Background‑Handling
- Output‑Konfiguration und Format‑Validierung
- Streaming von Frames an Output‑Adapter/Helper

## Entry Points (Commands)
Graphics‑Commands kommen über den Relay‑Client in die Bridge:
1. `apps/bridge/src/services/relay-client.ts` empfängt `command`‑Messages.
2. `apps/bridge/src/services/command-router.ts` dispatcht `graphics_*`.
3. `apps/bridge/src/services/graphics/graphics-manager.ts` führt aus.

Relevante Commands:
- `graphics_configure_outputs`
- `graphics_send`
- `graphics_update_values`
- `graphics_update_layout`
- `graphics_remove`
- `graphics_remove_preset`
- `graphics_test_pattern`
- `graphics_list`

## Datenfluss (Mermaid)
```mermaid
sequenceDiagram
  participant Relay as Relay Server
  participant RC as RelayClient
  participant CR as CommandRouter
  participant GM as GraphicsManager
  participant R as RendererClient
  participant ER as ElectronRenderer
  participant OA as OutputAdapter
  participant DH as DeckLink Helper

  Relay->>RC: command (graphics_*)
  RC->>CR: handleCommand(command, payload)
  CR->>GM: graphics_*()
  GM->>GM: validate + sanitize
  GM->>R: renderLayer/updateValues/updateLayout
  R->>ER: IPC create/update/remove
  ER-->>R: frame (RGBA)
  R-->>GM: onFrame(layerId, buffer)
  GM->>GM: composite layers
  GM->>OA: sendFrame(RGBA)
  OA->>DH: stdin stream (frames)
```

## Validierung & Sicherheit
- Zod‑Schemas: `apps/bridge/src/services/graphics/graphics-schemas.ts`
- Template‑Sanitizing: `apps/bridge/src/services/graphics/template-sanitizer.ts`
  - Blockiert Scripts, Inline‑Events, externe URLs, `@import`, etc.
- Asset‑Handling: `apps/bridge/src/services/graphics/asset-registry.ts`
  - Größenlimits, Asset‑Manifest, `asset://`‑Protokoll im Renderer
- IPC‑Sicherheit Renderer:
  - Token‑Handshake, Payload‑Limits
  - Lokal gebunden an `127.0.0.1`

## Output‑Konfiguration & Device‑Validierung
`GraphicsManager.configureOutputs` validiert:
- Output‑Targets (Port‑Typ, Port‑Rolle, Verfügbarkeit)
- Format‑Support (Width/Height/FPS + Pixel‑Formats)

Dabei werden Device‑Infos aus `device-cache` und Display‑Modes aus dem DeckLink‑Helper verwendet:
- `apps/bridge/src/services/device-cache.ts`
- `apps/bridge/src/modules/decklink/decklink-detector.ts`
- `apps/bridge/src/modules/decklink/decklink-helper.ts`

## Renderer‑IPC (Offscreen)
Renderer‑Client: `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- Startet Electron‑Rendererprozess mit IPC‑Port + Token
- Befehle: `set_assets`, `create_layer`, `update_values`, `update_layout`, `remove_layer`

Renderer‑Entry: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- Offscreen BrowserWindow pro Layer
- `paint`‑Event liefert BGRA → RGBA
- Sendet `frame`‑Messages via IPC zurück

## Output‑Adapter
- `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-split-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/stub-output-adapter.ts`

Frames werden mit Header‑Protokoll an den nativen Helper (DeckLink) oder an den Display‑Helper (Electron Fullscreen) gestreamt.

## Fehlerbilder (typisch)
- Output nicht konfiguriert → `Outputs not configured`
- Format/Port ungültig → Validation Fehler
- Renderer nicht verfügbar → Fallback auf Stub Renderer
- DeckLink Helper fehlt/keine Rechte → configure() Fehler

## Relevante Dateien
- `apps/bridge/src/services/relay-client.ts`
- `apps/bridge/src/services/command-router.ts`
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-schemas.ts`
- `apps/bridge/src/services/graphics/template-sanitizer.ts`
- `apps/bridge/src/services/graphics/asset-registry.ts`
- `apps/bridge/src/services/graphics/renderer/*`
- `apps/bridge/src/services/graphics/output-adapters/*`
- `apps/bridge/src/modules/decklink/*`
