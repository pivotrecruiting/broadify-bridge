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

## Supersampling & Capture-Downscale
- Studio-Renderer bei 1920x1080 bleiben bei Render-Scale 1.
- Meeting-Planes `bfy-meet-gfx-back` und `bfy-meet-gfx-front` rendern bis
  1920x1080 standardmaessig mit Render-Scale 2 und schreiben nach dem
  Downscale weiter 1920x1080 in den FrameBus.
- `BRIDGE_GRAPHICS_SUPERSAMPLE` bleibt der globale Override und gewinnt vor
  allen Meeting-Regeln; Werte werden auf 1..3 geklemmt.
- `BRIDGE_GRAPHICS_MEETING_SUPERSAMPLE` steuert nur Meeting-Planes. Ohne Env
  gilt 2; `0` oder `1` deaktiviert Meeting-Supersampling, hoehere Werte werden
  auf 3 geklemmt.
- 1280x720 und kleiner behalten die bestehende 2x-Regel fuer alle Renderer,
  solange kein globaler Override oder Clamp-Fallback aktiv ist.
- Capture-Frames werden bei Groessenabweichung zuerst ueber
  `NativeImage.resize({ width, height, quality: "best" })` auf Zielgroesse
  gebracht. Nur wenn dieser native Pfad nicht verfuegbar ist oder kein
  passendes Zielbild liefert, greift der bestehende JS-Downscale-Fallback.
- Wenn Windows ein supersampled Offscreen-Window auf die Work-Area klemmt,
  deaktiviert der Renderer Supersampling fuer diese Session einmalig, baut das
  Fenster mit Scale 1 neu auf und loggt
  `[GraphicsRenderer] Supersampling disabled after work-area clamp`. Bleibt
  auch Scale 1 geklemmt, meldet der bestehende Clamp-Error die beschnittene
  Viewport-Groesse.

## Session-Handshake
- `renderer_configure` vor `create_layer` (width/height/fps/pixelFormat/framebusName/framebusSize).
- `ready` Event erst nach erfolgreicher Konfiguration.
- `backgroundMode` default: `transparent`; optional `clearColor` überschreibt den Hintergrund.

## Status (Stand heute)
- Shadow-DOM Wrapper pro Layer umgesetzt.
- Bindings auf Layer-Host umgestellt.
- FrameBus-Writer integriert.
- Update-Commands auf Layer-Host gemappt (kein globales DOM).
