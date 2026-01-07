# Graphics Bridge Implementation Checklist

## Ziele

- Graphics-Commands korrekt verarbeiten.
- Output-Konfiguration global anwenden.
- RGBA-Rendering stabil ausliefern.

## Vorbereitungen

- [ ] Renderer-Umgebung (Electron Offscreen) bereitstellen.
- [ ] Asset-Registry fuer lokale Assets.
- [ ] Output-Adapter fuer SDI/NDI initialisieren.
- [ ] Renderer IPC (TCP) zwischen Bridge und Electron Child.

## Command Router

- [ ] `graphics_configure_outputs` validieren (outputKey + targets + format).
- [ ] `graphics_send` validieren (bundle + values + layout + zIndex).
- [ ] `graphics_update_values` validieren.
- [ ] `graphics_update_layout` validieren.
- [ ] `graphics_remove` validieren.
- [ ] `graphics_list` implementieren.
- [ ] Einheitliches Response-Format `{ success, data, error }`.

## Output-Konfiguration

- [ ] `key_fill_sdi` -> output1Id + output2Id Pflicht, unterschiedlich.
- [ ] `video_sdi` -> output1Id Pflicht.
- [ ] `key_fill_ndi` -> ndiStreamName Pflicht.
- [ ] Format pruefen (aktuell fix: 1920x1080 @ 50fps).
- [ ] Output-Adapter fuer jeden Modus korrekt konfigurieren.

## Renderer

- [ ] Template-Bundle sanitizen (kein JS, keine externen URLs).
- [ ] HTML/CSS rendern -> RGBA Framebuffer.
- [ ] Values ohne Full-Reload anwenden.
- [ ] Hintergrund bei Key&Fill immer als transparent behandeln.
- [ ] Renderer Child startet ohne Node Integration.

## Layer-Management

- [ ] Layer Registry (layerId -> state).
- [ ] Z-Order und Layout beruecksichtigen.
- [ ] Composite Pipeline (alle aktiven Layer).
- [ ] `graphics_remove` entfernt Layer aus Composite.

## Output Adapter

- [ ] SDI Key&Fill: RGB -> Fill, Alpha -> Key.
- [ ] NDI Key&Fill: RGBA in Stream mit Alpha.
- [ ] Video SDI: RGBA gegen Background compositen.

## Diagnostics

- [ ] `graphics_list` liefert outputConfig + aktive Layer.
- [ ] Errors mit klaren Strings zurueckgeben.
- [ ] Basic Metrics: fps, droppedFrames (optional).
- [ ] Output-Config persistieren (userData/graphics-output.json).

## Tests

- [ ] Smoke Test: graphics_send mit einem Layer.
- [ ] Key&Fill SDI Output korrekt.
- [ ] NDI Stream sichtbar und Alpha nutzbar.
- [ ] Video SDI mit Background korrekt.
