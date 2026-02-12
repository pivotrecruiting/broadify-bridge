# Graphics Realtime – Legacy Removal Plan (No Rollback)

## Ziel
Vollständige Entfernung aller Legacy-Pfade in der Graphics-Pipeline, sodass nur noch ein konsistenter Pfad existiert:
- Single Renderer (ein Offscreen-Window, Layer via Shadow DOM)
- FrameBus als Data-Plane
- IPC nur als Control-Plane (Handshake, Commands, Error/Ready)

## Entscheidungsrahmen
- Kein Rollback-Pfad.
- Keine Feature-Flags für alte Pfade.
- Software war noch nie produktiv online, daher direkte Bereinigung statt Parallelbetrieb.

## Scope (was entfernt wird)
1. Renderer-Legacy
- Multi-Window Renderer-Pfad im `electron-renderer-entry.ts`.
- Legacy `frame`-Payload über IPC (Pixel-Transport via IPC).
- Flag-abhängige Umschaltung über `BRIDGE_GRAPHICS_RENDERER_SINGLE`.

2. Bridge-Legacy
- Compositing/Ticker/`onFrame` Pipeline in `graphics-manager.ts`.
- Abhängigkeit auf `composite.ts` für Output-Frame-Erzeugung.

3. Output-Legacy
- `key_fill_split_sdi` Legacy-Software-Split-Pfad.
- `DecklinkSplitOutputAdapter` und zugehörige Split-Frame-Logik.
- Verbleibende Legacy-Kommentare/Verträge zu stdin-Framepfad.

4. Config/Contracts/Docs
- Legacy-Keys/Flags in Config-Schema und Doku.
- Widersprüche zwischen Refactor-Dokumenten und Implementierung.

## Out of Scope
- Neue Output-Modi außerhalb des aktuellen SSOT.
- Cross-Platform Ausbau (Windows/Linux).

## Umsetzung in Phasen

### Phase 1: Control-Plane/Data-Plane hart festziehen
1. `apps/bridge/src/default-config-loader.ts`
- `rendererSingle` und zugehörige Env-Setzung entfernen.

2. `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- Single-Path als einziges Verhalten behalten.
- Multi-Window-Funktionen und `type: "frame"` Versand entfernen.

3. `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- Annahmen für Legacy-Frame-Callbacks entfernen (kein Pixelpfad über IPC).

### Phase 2: Bridge-Legacy entfernen
1. `apps/bridge/src/services/graphics/graphics-manager.ts`
- Ticker entfernen.
- Legacy `tick()`/Compositing-Pfad entfernen.
- Legacy `onFrame` Konsum entfernen.

2. `apps/bridge/src/services/graphics/composite.ts`
- Datei löschen, wenn keine Referenz mehr existiert.

3. `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
- Interface bereinigen (Legacy `onFrame` entfernen, falls nicht mehr benötigt).

### Phase 3: Output-Legacy entfernen
1. `apps/bridge/src/services/graphics/output-adapters/decklink-split-output-adapter.ts`
- Adapter entfernen.

2. `apps/bridge/src/services/graphics/graphics-schemas.ts`
- `key_fill_split_sdi` entfernen.

3. `apps/bridge/src/services/graphics/graphics-manager.ts`
- Auswahl-/Validierungslogik für `key_fill_split_sdi` entfernen.

4. Betroffene Dokumentation/Referenzen
- Verweise auf Split-Legacy und stdin-Framepfad entfernen.

### Phase 4: Konsistenz & Verifikation
1. Build-/Release-Checks
- Sicherstellen, dass nur der Single-FrameBus-Pfad gebaut wird.
- Diagnose-Logs auf nur noch relevanten Pfad reduzieren.

2. Tests/Smoke
- Graphics configure/send/update/remove mit `video_sdi`, `video_hdmi`, `key_fill_sdi`.
- Renderer-Handshake + FrameBus-Writer Init als harte Akzeptanzkriterien.

## Security-Risiken und Mitigation
1. IPC-Manipulation (lokal)
- Risiko: unautorisierte lokale Clients senden Renderer-Commands.
- Mitigation: Token-Handshake strikt beibehalten, Bindung nur an `127.0.0.1`, Input-Validierung weiter über Zod.

2. Shared-Memory Zugriff (FrameBus)
- Risiko: Prozessfremder Zugriff auf Shared Memory Name.
- Mitigation: zufällige FrameBus-Namen pro Session, keine externen Overrides im Renderer aus untrusted Input, keine Secrets in FrameBus.

3. Device Helper Steuerung
- Risiko: unklare Prozesszustände bei Start/Stop.
- Mitigation: idempotentes Start/Stop, harte Ready-Handshake-Validierung, Exit-Code/Signal Logging.

## Abnahmekriterien (Definition of Done)
1. Kein Legacy-Codepfad mehr für Renderer/Bridge/Output vorhanden.
2. Keine Runtime-Entscheidung mehr zwischen Single/Legacy.
3. `key_fill_split_sdi` existiert nicht mehr in Schema/API.
4. Graphics läuft stabil für `video_sdi`, `video_hdmi`, `key_fill_sdi`.
5. Refactor-Doku ist widerspruchsfrei und als SSOT nutzbar.

## Arbeits-Backlog (umsetzbar in PR-Reihenfolge)
- [ ] PR1: Renderer-Legacy entfernen (Single-only erzwingen).
- [ ] PR2: Bridge-Ticker/Compositing/`onFrame` entfernen.
- [ ] PR3: Split-Output entfernen (`key_fill_split_sdi` + Adapter + Validierung).
- [ ] PR4: Doku/Contracts bereinigen und finale Smoke-Checks dokumentieren.
