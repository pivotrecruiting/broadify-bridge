# Graphics Realtime Refactor – Migrationsplan

## Best Practices (verbindlich)
- SSOT respektieren, keine Duplizierung von Logik.
- Single Responsibility pro Modul und Prozess.
- Feature-Flags für alle riskanten Umschaltungen.
- Observability vor Performance-Optimierung.
- Messbare Akzeptanzkriterien pro Phase.
- Rollback-Strategie für jede Phase.
- Plattform-Status: macOS only (Windows/Linux deferred).

## Phasen
### Phase 0 – Vorbereitung
- Architektur final bestätigen.
- Frame-Format und Target-FPS pro Output-Key dokumentieren.
- Feature-Flag Plan definieren (Renderer, FrameBus, Output-Helper).
- Test-Template definieren (Minimal + Stress).
- Metriken definieren (fps, drops, latency).

### Phase 1 – FrameBus (Shared Memory)
- N-API Modul implementieren.
- JS-Wrapper in Bridge einführen.
- Tests für Writer/Reader.
- Performance-Test (Throughput + Latenz).
- Security-Review (Shared Memory Zugriff).

### Phase 2 – Renderer Refactor
- Single-Window Rendering.
- Layer-Isolation via Shadow DOM.
- FrameBus-Writer integrieren.
- Renderer-Command Contract final integrieren.
- Fallback auf bisherigen Renderer per Feature-Flag.

### Phase 3 – Output-Helper
- DeckLink Helper liest FrameBus.
- Display Helper liest FrameBus.
- FPS-Ticker pro Helper.
- Fallback auf bisherigen Output-Adapter per Feature-Flag.

### Phase 4 – Bridge Cleanup
- Compositing entfernen.
- Ticker entfernen.
- Output-Adapter auf Runner-API umstellen.
- Dead-Code-Räumung erst nach stabiler Produktion.

### Phase 5 – Tests & Observability
- FPS/Latency Logging.
- Realtime-Tests pro Output-Key.
- Regression-Test der Graphics-Commands.
- Release-Tests pro Plattform (macOS/Win/Linux).

## Betroffene Dateien (SSOT für Refactor)
### Bridge Core
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-schemas.ts`
- `apps/bridge/src/services/graphics/template-bindings.ts`
- `apps/bridge/src/services/graphics/composite.ts` (voraussichtlich obsolet)

### Renderer
- `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- `apps/bridge/src/services/graphics/renderer/animation-css.ts`

### Output-Helper
- `apps/bridge/src/services/graphics/output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/decklink-split-output-adapter.ts`
- `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- `apps/bridge/src/services/graphics/display/display-output-entry.ts`
- `apps/bridge/src/services/graphics/display/display-output-preload.cts`

### Native
- `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`
- New: `apps/bridge/native/framebus/` (Shared Memory Module)

### Docs
- `docs/bridge/refactor/*.md`
- `docs/bridge/README.md`

## TODO
- [ ] Finales Frame-Format pro Output-Key dokumentieren.
- [x] Entscheidung festhalten: Key/Fill nutzt ARGB8-only (kein BGRA-Fallback).
- [ ] Hinweis: Akzeptanzkriterien ggf. pro Hardware/Output anpassen.
- [ ] Display-Output Format-Validierung ergänzen.
- [ ] Migrations-Reihenfolge für macOS finalisieren (Windows/Linux deferred).

## Feature-Flags (Vorschlag)
- `BRIDGE_GRAPHICS_FRAMEBUS=1` aktiviert FrameBus.
- `BRIDGE_GRAPHICS_RENDERER_SINGLE=1` aktiviert Single-Window Renderer.
- `BRIDGE_GRAPHICS_OUTPUT_HELPER_FRAMEBUS=1` aktiviert FrameBus Reader im Helper.

## Legacy-Fallback (Notfall)
- Wird nur genutzt, wenn die Feature-Flags oben deaktiviert sind oder explizit zurückgeschaltet wird.
- Bridge nutzt dann den alten IPC-Frame-Transport, Compositing und Ticker.
- Output-Helper erhält Frames über den bisherigen stdin-Transport.
- Darf nur im größten Notfall verwendet werden.

## Rollback-Plan (pro Phase)
- Phase 1: FrameBus deaktivieren, IPC bleibt aktiv.
- Phase 2: Renderer auf Multi-Window zurück.
- Phase 3: Output-Helper auf stdin-Frames zurück.
- Phase 4: Cleanup nur nach stabiler Produktion.

## Akzeptanzkriterien (minimal)
- 1080p@50: Renderer fps ≥ 50, Drops ≈ 0 über 60s.
- Output-Helper fps stabil ±1 fps über 60s.
- Trigger->Frame Latenz messbar < 200ms.
 - Hinweis: Werte ggf. pro Hardware/Output anpassen.

## Risiken
- CSS-Kollisionen ohne Shadow DOM.
- Shared Memory Rechte/Isolation.
- Frame-Format Mismatch pro Output-Helper.

## Abhängigkeiten
- N-API Build Toolchain in CI.
- DeckLink Helper Build/Signierung.
- Display Helper GPU Pipeline.

## Detail-TODOs (nach Verantwortlichkeit)
### Bridge (Control-Plane)
- [ ] `graphics-manager.ts`: Compositing und Ticker entfernen.
- [ ] `graphics-manager.ts`: Renderer-Lifecycle auf Single-Window umstellen.
- [ ] `command-router.ts`: Fehlercodes für Output-Helper-Fehler definieren.
- [ ] `template-bindings.ts`: Binding-Targets für Shadow DOM planen.

### Renderer (Electron)
- [x] `electron-renderer-entry.ts`: Single-Window + Layer-Host-Registry.
- [x] `electron-renderer-entry.ts`: Shadow DOM pro Layer erstellen.
- [x] `electron-renderer-entry.ts`: `applyValues` auf Shadow DOM ausrichten.
- [x] `electron-renderer-entry.ts`: FrameBus-Writer integrieren.
- [x] `animation-css.ts`: Injection-Strategie pro Layer festlegen.

### Output-Helper
- [x] DeckLink Helper: FrameBus Reader + FPS-Ticker.
- [x] Display Helper: FrameBus Reader.
- [ ] Display Helper: GPU-Renderer finalisieren.
- [ ] Output-Adapter: Start/Stop-Handshakes anpassen.

### Native / FrameBus
- [x] Shared Memory API definieren (C++ Header).
- [x] N-API Bindings für Node/Electron bauen (macOS).
- [ ] Cross-Platform Implementierung (Windows/Linux deferred).
- [ ] FrameBus API Spec finalisieren: `docs/bridge/refactor/graphics-realtime-framebus-api.md`

### Observability
- [ ] FPS/Latency Metrics in Renderer und Output-Helper.
- [x] Debug-Overlay optional für Display-Output.

### Contracts
- [ ] Renderer Command Contract finalisieren: `docs/bridge/refactor/graphics-realtime-renderer-command-contract.md`
- [ ] Output Helper Contract finalisieren: `docs/bridge/refactor/graphics-realtime-output-helper-contract.md`
