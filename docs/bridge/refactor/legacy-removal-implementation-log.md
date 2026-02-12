# Legacy Removal – Implementation Log (Step 1)

## Zweck
Laufende Umsetzungsdokumentation für die vollständige Entfernung der Legacy-Graphics-Pfade.

Für jede bearbeitete Datei wird erfasst:
- aktueller Stand der Änderungen
- Line Count
- Komplexität (niedrig/mittel/hoch)
- SSOT/SRP-Bewertung
- Refactor/Outsourcing-Kandidaten für Schritt 2

## Datei-Log

### apps/bridge/src/default-config-loader.ts
- Status: done
- Änderungen: `rendererSingle` entfernt; keine Env-Umschaltung auf Legacy-Renderer mehr.
- Line Count: 78
- Komplexität: niedrig
- SSOT/SRP Analyse: Datei ist weiterhin fokussiert auf Default-Config-Loading; SRP ok.
- Step-2 Refactor: optional JSON-Parsing und Env-Mapping in kleine Helper aufteilen, falls weitere Config-Bereiche hinzukommen.

### config/default.json
- Status: done
- Änderungen: Legacy-Key `rendererSingle` entfernt.
- Line Count: 6
- Komplexität: niedrig
- SSOT/SRP Analyse: Datei ist SSOT für Default-Graphics-Config; SRP klar.
- Step-2 Refactor: optional Trennung in `graphics/default.json` und `relay/default.json`, falls Konfigurationsumfang wächst.

### apps/bridge/src/services/graphics/renderer/graphics-renderer.ts
- Status: done
- Änderungen: `GraphicsFrameT` und `onFrame()` entfernt; Interface ist jetzt reiner Control-Plane-Contract.
- Line Count: 114
- Komplexität: niedrig
- SSOT/SRP Analyse: gute SSOT-Position als zentraler Renderer-Vertrag; SRP erfüllt.
- Step-2 Refactor: optional Typen (`GraphicsTemplateBindingsT`, `GraphicsRendererConfigT`) in eigene `renderer-contract-types.ts` auslagern.

### apps/bridge/src/services/graphics/renderer/stub-renderer.ts
- Status: done
- Änderungen: Legacy-`onFrame`-Mechanik und Frame-Emission entfernt; Stub ist nur noch zustandsbehafteter No-op Renderer.
- Line Count: 58
- Komplexität: niedrig
- SSOT/SRP Analyse: SRP klar verbessert (kein Mischverhalten aus Rendern + Frame-Transport).
- Step-2 Refactor: optional generischer `NoopRendererBase` für Stub-/Test-Renderer einführen.

### apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts
- Status: done
- Änderungen: Legacy-`onFrame` API entfernt; IPC-`frame`/Binary-Payloads werden ignoriert; Client ist Control-Plane-only.
- Line Count: 886
- Komplexität: hoch
- SSOT/SRP Analyse: Legacy-Zweig entfernt, aber Datei bleibt sehr umfangreich (Process-Lifecycle, IPC-Protokoll, Logging, Config-State in einer Klasse).
- Step-2 Refactor: in Module zerlegen: `renderer-process-launcher`, `renderer-ipc-protocol`, `renderer-config-sync`, `renderer-log-parser`.

### apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts
- Status: done
- Änderungen: Multi-Window/IPC-Frame-Legacy entfernt; Single-Window + FrameBus als einziger Datenpfad; `renderer_configure` erzwingt FrameBus-Ready.
- Line Count: 1206
- Komplexität: hoch
- SSOT/SRP Analyse: Legacy-Bifurkation entfernt, aber Datei bleibt sehr groß (Window-Bootstrap, DOM-Template-Engine, FrameBus, IPC-Protokoll in einem Modul).
- Step-2 Refactor: auslagern in `renderer-bootstrap.ts`, `renderer-framebus-writer.ts`, `renderer-dom-runtime.ts`, `renderer-ipc-server.ts`.

### apps/bridge/src/services/graphics/graphics-manager.ts
- Status: done
- Änderungen: Legacy-Compositing/Ticker/`onFrame`-Pfad vollständig entfernt; `DecklinkSplitOutputAdapter`-Auswahl entfernt; Preset-Timer-Start auf `renderPreparedLayer` verschoben.
- Line Count: 1261
- Komplexität: hoch
- SSOT/SRP Analyse: Funktional korrekt auf Single-Path vereinfacht, aber Datei bleibt zu groß und bündelt zu viele Verantwortlichkeiten (Validation, Presets, Renderer-Orchestrierung, Output-Adapter-Selektion, Event-Publishing).
- Step-2 Refactor: in Services splitten: `graphics-output-config-service`, `graphics-layer-service`, `graphics-preset-service`, `graphics-output-validation-service`, `graphics-event-publisher`.

### apps/bridge/src/services/graphics/graphics-schemas.ts
- Status: done
- Änderungen: Legacy-Output-Key `key_fill_split_sdi` aus `GraphicsOutputKeySchema` entfernt; Einrückungs-/Formatierungsfehler bei `GraphicsSendSchema` bereinigt.
- Line Count: 209
- Komplexität: mittel
- SSOT/SRP Analyse: SSOT gestärkt, da veralteter Output-Modus entfernt wurde.
- Step-2 Refactor: Schema-Gruppen (`output`, `layer`, `preset`) in Teilmodule splitten, um Änderungsradius zu reduzieren.

### apps/bridge/src/services/graphics/output-adapters/decklink-split-output-adapter.ts
- Status: done (removed)
- Änderungen: Datei vollständig entfernt (Legacy `key_fill_split_sdi` Software-Split-Pfad).
- Line Count: 0 (deleted)
- Komplexität: n/a (deleted)
- SSOT/SRP Analyse: Entfernt einen widersprüchlichen Sonderpfad und stärkt SSOT auf nativen Key/Fill-Flow.
- Step-2 Refactor: kein weiterer Schritt nötig.

### apps/bridge/src/services/graphics/composite.ts
- Status: done (removed)
- Änderungen: Datei vollständig entfernt (Legacy-Software-Compositing entfällt).
- Line Count: 0 (deleted)
- Komplexität: n/a (deleted)
- SSOT/SRP Analyse: SSOT verbessert, da FrameBus alleiniger Datenpfad bleibt.
- Step-2 Refactor: kein weiterer Schritt nötig.
