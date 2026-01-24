# Graphics Bridge Implementation Checklist

## Ziele

- Graphics-Commands korrekt verarbeiten.
- Output-Konfiguration global anwenden.
- RGBA-Rendering stabil ausliefern.

## Vorbereitungen

- [x] Renderer-Umgebung (Electron Offscreen) bereitstellen.
- [x] Asset-Registry fuer lokale Assets.
- [x] Output-Adapter fuer SDI initialisieren.
- [ ] Output-Adapter fuer NDI (noch offen).
- [x] Renderer IPC (TCP) zwischen Bridge und Electron Child.

## Command Router

- [x] `graphics_configure_outputs` validieren (outputKey + targets + format).
- [x] `graphics_send` validieren (bundle + values + layout + zIndex).
- [x] `graphics_update_values` validieren.
- [x] `graphics_update_layout` validieren.
- [x] `graphics_remove` validieren.
- [x] `graphics_list` implementieren.
- [x] Einheitliches Response-Format `{ success, data, error }`.

## Output-Konfiguration

- [x] Output-Key validieren (`key_fill_sdi`, `video_sdi`, `video_hdmi`, `key_fill_ndi`, `stub`).
- [x] Format pruefen gegen Device/Modes (DeckLink Helper list-modes).
- [x] Output-Adapter korrekt konfigurieren.
- [x] Range-Config fuer Legal/Full implementiert.

## Renderer

- [x] Template-Bundle sanitizen (kein JS, keine externen URLs).
- [x] HTML/CSS rendern -> RGBA Framebuffer.
- [x] Values ohne Full-Reload anwenden.
- [x] Hintergrund bei Key&Fill immer als transparent behandeln.
- [x] Renderer Child startet ohne Node Integration.

## Layer-Management

- [x] Layer Registry (layerId -> state).
- [x] Z-Order und Layout beruecksichtigen.
- [x] Composite Pipeline (alle aktiven Layer).
- [x] `graphics_remove` entfernt Layer aus Composite.

## Output Adapter

- [x] DeckLink Key&Fill Adapter (SDI, external keying).
- [x] DeckLink Video Adapter (SDI/HDMI).
- [x] Stub-Adapter implementiert (keine echte Ausgabe).

## Diagnostics

- [x] `graphics_list` liefert outputConfig + aktive Layer.
- [x] Errors mit klaren Strings zurueckgeben.
- [x] Basic Metrics: fps, droppedFrames (optional).
- [x] Output-Config persistieren (userData/graphics-output.json).

## Tests

- [x] Smoke Test Script: `apps/bridge/scripts/graphics-smoke.ts`.
