# Graphics Realtime Refactor – Renderer Design

## Ziel
Ein einzelnes Offscreen-Window rendert alle Layer in einem DOM-Tree. Frames werden in den FrameBus geschrieben.

## Layer-Isolation
- Jeder Layer wird in einem eigenen Shadow DOM gerendert.
- CSS wird pro Layer injiziert, keine globalen Kollisionsrisiken.

### Struktur (Vorschlag)
- Root Container: `#graphics-root`
- Pro Layer: `div[data-layer-id]` als Host
- Pro Host: `host.attachShadow({ mode: \"closed\" })`
- Shadow DOM enthält:
  - `<style>` (Standard-Animation + Template-CSS)
  - `<div data-root=\"graphic\">` (Template-Root)

### Binding-Änderungen
- CSS-Variablen werden auf den Layer-Host gesetzt (nicht auf `:root`).
- Text-Bindings laufen im Shadow DOM, nicht im globalen DOM.
- Animation-Klassen werden am Shadow-Root-Element gesetzt.

## Bindings
- CSS-Variablen, Text-Updates und Animationen werden pro Layer angewendet.
- `animation-css.ts` wird pro Layer eingebunden.

## Rendering
- Offscreen Window mit `backgroundThrottling=false`.
- `paint`-Event liefert Frame-Buffer.
- Frame wird direkt in den FrameBus geschrieben.

## TODO
- [ ] Shadow-DOM Wrapper-Komponente definieren.
- [ ] Bindings auf Layer-Host umstellen.
- [ ] FrameBus-Writer integrieren.
- [ ] Update-Commands auf Layer-Host mappen (no global DOM).
