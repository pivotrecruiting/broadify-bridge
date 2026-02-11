# Graphics Realtime Refactor – Renderer Command Contract

## Zweck
Definiert die Control-Plane Nachrichten zwischen Bridge und Renderer für das Single-Window Rendering mit Shadow DOM je Layer.

## SSOT Referenzen
- Renderer Interface: `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
- Renderer Entry: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- Template Bindings: `apps/bridge/src/services/graphics/template-bindings.ts`

## Neues Session-Setup (Vorschlag)
### `renderer_configure`
- Zweck: Session-Parameter setzen, bevor Layers erstellt werden.
- Payload:
  - `width`, `height`, `fps`
  - `pixelFormat` (FrameBus PixelFormat Enum)
  - `framebusName`
  - `framebusSize`
  - `backgroundMode`
  - `clearColor` (optional, `{ r, g, b, a }`, r/g/b 0-255, a 0-1)

## Asset-Handling
### `set_assets` (bestehend, beibehalten)
- Payload: `{ assets: { [assetId]: { filePath, mime } } }`
- SSOT: `asset-registry.ts`

## Layer Commands
### `create_layer`
- Payload:
  - `layerId`
  - `html`
  - `css`
  - `values`
  - `bindings`
  - `layout`
  - `backgroundMode`
  - `zIndex`

### `update_values`
- Payload:
  - `layerId`
  - `values`
  - `bindings`

### `update_layout`
- Payload:
  - `layerId`
  - `layout`
  - `zIndex` (optional)

### `remove_layer`
- Payload:
  - `layerId`

### `shutdown`
- Payload: none

## Events (Renderer -> Bridge)
### `ready`
- Zweck: Renderer ist konfiguriert, FrameBus verbunden.
- Payload:
  - `width`, `height`, `fps`
  - `pixelFormat`
  - `framebusName`

### `error`
- Payload:
  - `message`

## Renderer-Verhalten (Shadow DOM)
- Pro `create_layer` wird ein Host-Element erstellt.
- `host.attachShadow({ mode: "closed" })`
- CSS + Animationen werden in Shadow DOM injiziert.
- Bindings werden auf den Layer-Host angewendet.

## Änderungen am Interface
- Im Primärpfad wird `onFrame()` durch FrameBus ersetzt.
- `initialize()` wird durch `renderer_configure()` erweitert.

## Legacy-Fallback (Notfall)
- Wenn FrameBus deaktiviert ist, bleibt der IPC-Frame-Transport aktiv.
- Bridge nutzt dann `onFrame()` für den alten Compositing/Ticker-Flow.
- Dieser Pfad ist nur für Notfälle vorgesehen.

## Finalisiert
### Finaler Abgleich
- `renderer_configure` Payload: `width`, `height`, `fps`, `pixelFormat`, `framebusName`, `framebusSize`, `backgroundMode`, `clearColor`.
- `ready` Payload: `width`, `height`, `fps`, `pixelFormat`, `framebusName`.
- IPC-Handshake: Renderer sendet `ready` erst nach `renderer_configure`.
- Payloads werden strikt validiert (Zod) im Renderer.
