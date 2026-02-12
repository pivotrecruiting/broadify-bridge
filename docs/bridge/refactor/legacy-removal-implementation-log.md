# Legacy Removal – Implementation Log (Step 1 + Step 2)

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
- Status: step-2 done
- Änderungen: Prozess-/Entry-Resolution ausgelagert (`electron-renderer-launch.ts`), IPC-Framing ausgelagert (`renderer-ipc-framing.ts`), Log-Line-Parsing ausgelagert (`renderer-log-parser.ts`).
- Line Count: 754
- Komplexität: mittel-hoch
- SSOT/SRP Analyse: deutlich bessere Trennung zwischen Lifecycle-Orchestrierung und Infrastruktur-Helfern; Klasse enthält weiterhin Config-Sync + Process-State.
- Nächster Refactor: `renderer-config-sync` als eigenes Modul extrahieren, um die Klasse auf Process/IPC-Orchestrierung zu begrenzen.

### apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts
- Status: step-2 done
- Änderungen: DOM-Runtime ausgelagert (`electron-renderer-dom-runtime.ts`), Configure-Schema ausgelagert (`renderer-config-schema.ts`), IPC-Framing auf shared Utility umgestellt (`renderer-ipc-framing.ts`).
- Line Count: 897
- Komplexität: hoch
- SSOT/SRP Analyse: SRP klar verbessert (DOM/Schema/Framing getrennt), aber FrameBus-Writer-State + IPC-Verbindungssteuerung + Window-Lifecycle liegen noch gemeinsam.
- Nächster Refactor: `renderer-framebus-runtime.ts` und `renderer-ipc-client.ts` extrahieren.

### apps/bridge/src/services/graphics/graphics-manager.ts
- Status: step-2 advanced
- Änderungen: atomare Transition vollständig an `graphics-output-transition-service.ts` delegiert; Layer-Prepare-Pipeline an `graphics-layer-prepare-service.ts` ausgelagert.
- Line Count: 731
- Komplexität: mittel-hoch
- SSOT/SRP Analyse: SRP weiter verbessert, da Transition-/Rollback und Prepare-Pipeline außerhalb liegen; verbleibend ist primär Orchestrierung plus Payload-Diagnostics.
- Nächster Refactor: `graphics-payload-diagnostics.ts` auslagern.

### apps/bridge/src/services/graphics/graphics-output-transition-service.ts
- Status: step-2 done (new)
- Änderungen: serialisierte atomare Output-Transition extrahiert (queue, staged apply, persist-last, rollback, rollback-fallback).
- Line Count: 219
- Komplexität: hoch
- SSOT/SRP Analyse: zentrale SSOT für Output-Transition-Konsistenz; reduziert Risiko inkonsistenter Runtime-/Persistenzzustände.
- Nächster Refactor: optional adapter-rollback/details in `graphics-output-rollback-service.ts` splitten, falls Umfang wächst.

### apps/bridge/src/services/graphics/graphics-manager-types.ts
- Status: step-2 done (new)
- Änderungen: gemeinsame Runtime-Typen (`GraphicsLayerStateT`, `GraphicsActivePresetT`, `PreparedLayerT`, Status-Snapshot) zentralisiert.
- Line Count: 57
- Komplexität: niedrig
- SSOT/SRP Analyse: SSOT für Manager-nahe Domain-States; reduziert Typ-Drift zwischen Manager und Services.
- Nächster Refactor: optional Trennung zwischen API-Types und Runtime-Types, falls externe Nutzung entsteht.

### apps/bridge/src/services/graphics/graphics-layer-service.ts
- Status: step-2 done (new)
- Änderungen: Layer-Limits, Render-State-Apply, globales Layer-Clearing und generische Layer-Removal-Helfer ausgelagert.
- Line Count: 161
- Komplexität: mittel
- SSOT/SRP Analyse: SRP klar auf Layer-Lifecycle fokussiert; vom Manager entkoppelt über explizite Dependency-Parameter.
- Nächster Refactor: optional split in `graphics-layer-render-service.ts` und `graphics-layer-state-service.ts`.

### apps/bridge/src/services/graphics/graphics-layer-prepare-service.ts
- Status: step-2 done (new)
- Änderungen: Security-kritische Prepare-Pipeline extrahiert (CSS sanitization, template validation, asset reference checks, binding derivation, renderer asset refresh, alpha-background enforcement).
- Line Count: 73
- Komplexität: mittel
- SSOT/SRP Analyse: klare SSOT für Layer-Prepare-Regeln; reduziert Regression-Risiko bei Template-/Asset-Änderungen.
- Nächster Refactor: optional Aufteilung in `graphics-template-security-service.ts` und `graphics-asset-validation-service.ts`.

### apps/bridge/src/services/graphics/graphics-preset-service.ts
- Status: step-2 advanced
- Änderungen: Preset-Timer vollständig in `graphics-preset-timer.ts` ausgelagert; Service nutzt jetzt Timer-SSOT über klare Funktionsaufrufe.
- Line Count: 287
- Komplexität: mittel-hoch
- SSOT/SRP Analyse: deutlich bessere SRP-Trennung zwischen Preset-Orchestrierung und Timer-Mechanik; verbleibend sind Removal-/Replacement-Strategien in einer Datei.
- Nächster Refactor: optional Removal-Pfade in `graphics-preset-removal-service.ts` auslagern.

### apps/bridge/src/services/graphics/graphics-preset-timer.ts
- Status: step-2 done (new)
- Änderungen: Timer-SSOT eingeführt (`maybeStartPresetTimer`, `setPresetDurationPending`, `clearPresetDuration`, `clearPresetTimer`).
- Line Count: 80
- Komplexität: niedrig
- SSOT/SRP Analyse: klare Isolation der Timer-Lifecycle-Regeln; reduziert Kopplung und senkt Regression-Risiko bei Preset-Duration-Änderungen.
- Nächster Refactor: optional Unit-Tests mit Fake-Time für Start/Stop/Expire-Edge-Cases.

### apps/bridge/src/services/graphics/graphics-event-publisher.ts
- Status: step-2 done (new)
- Änderungen: `graphics_status`/`graphics_error` Publishing als zentrale Bridge-Event-Funktionen ausgelagert.
- Line Count: 48
- Komplexität: niedrig
- SSOT/SRP Analyse: klarer SRP-Gewinn, konsistente Event-Payload-Struktur an einer Stelle.
- Nächster Refactor: optional typed event contracts statt `string` reason/code.

### apps/bridge/src/services/graphics/graphics-output-validation-service.ts
- Status: step-2 done (new)
- Änderungen: Ziel-/Portvalidierung und Formatvalidierung zentralisiert; keine Verteilungslogik mehr im Manager.
- Line Count: 173
- Komplexität: mittel
- SSOT/SRP Analyse: klare SSOT für Output-Validierungsregeln; SRP fokussiert auf Validierung.
- Nächster Refactor: optional `device-capability-validator` abspalten, falls weitere Output-Typen dazukommen.

### apps/bridge/src/services/graphics/graphics-output-adapter-factory.ts
- Status: step-2 done (new)
- Änderungen: Adapterauswahl zentralisiert (`key_fill_sdi`/`video_sdi`/`video_hdmi`/`stub`) inkl. Display-vs-DeckLink-Entscheidung.
- Line Count: 37
- Komplexität: niedrig
- SSOT/SRP Analyse: SRP klar; Auswahlregeln liegen an einer Stelle.
- Nächster Refactor: optional Mapping-basierte Registry statt if-Kette bei wachsender Adapterzahl.

### apps/bridge/src/services/graphics/graphics-device-port-resolver.ts
- Status: step-2 done (new)
- Änderungen: Wiederverwendbare Port-Resolution (`findDevicePort`, Cache-Lookup) extrahiert.
- Line Count: 40
- Komplexität: niedrig
- SSOT/SRP Analyse: SRP klar; reduziert doppelte Port-Suchlogik in Manager/Validierung/Factory.
- Nächster Refactor: optional Caching-Strategie + typed error results statt `null`.

### apps/bridge/src/services/graphics/graphics-schemas.ts
- Status: step-2 done
- Änderungen: Datei in Aggregator transformiert; Schema-Gruppen in Teilmodule ausgelagert (`schemas/output-schemas.ts`, `schemas/layer-schemas.ts`).
- Line Count: 44
- Komplexität: niedrig
- SSOT/SRP Analyse: SSOT bleibt erhalten (ein stabiler Importpunkt), Änderungsradius pro Feature deutlich reduziert.
- Nächster Refactor: optional `schemas/runtime-validation.ts` für gemeinsame Validator-Helfer.

### apps/bridge/src/services/graphics/renderer/electron-renderer-launch.ts
- Status: step-2 done (new)
- Änderungen: Binary-/Entry-Resolution und Diagnostik aus Client ausgelagert.
- Line Count: 89
- Komplexität: niedrig
- SSOT/SRP Analyse: SRP klar, Fokus auf Launch-Auflösung.
- Nächster Refactor: optional Plattform-spezifische Auflösung via Strategy-Map.

### apps/bridge/src/services/graphics/renderer/renderer-ipc-framing.ts
- Status: step-2 done (new)
- Änderungen: Gemeinsames IPC-Framing (Limits, Encode, Decode) für Client und Entry eingeführt.
- Line Count: 113
- Komplexität: mittel
- SSOT/SRP Analyse: zentrale SSOT für IPC-Protokollgrenzen; reduziert Duplikation und Drift-Risiko.
- Nächster Refactor: optional `IpcProtocolErrorT` Typen statt String-Reasons.

### apps/bridge/src/services/graphics/renderer/renderer-log-parser.ts
- Status: step-2 done (new)
- Änderungen: Stream-Line-Drain und pino/plain-text Parsing aus Client ausgelagert.
- Line Count: 74
- Komplexität: niedrig
- SSOT/SRP Analyse: SRP klar; Logging-Parsing ist isoliert testbar.
- Nächster Refactor: optional dedizierte Unit-Tests für Level-Mapping.

### apps/bridge/src/services/graphics/renderer/electron-renderer-dom-runtime.ts
- Status: step-2 done (new)
- Änderungen: Vollständige Single-Window DOM/Template-Runtime aus Entry ausgelagert.
- Line Count: 262
- Komplexität: mittel
- SSOT/SRP Analyse: SRP verbessert (Entry enthält weniger UI-Embedded-Code), aber DOM-Runtime selbst bleibt komplex.
- Nächster Refactor: Template-/Binding-Helfer intern weiter splitten (`runtime-template.ts`, `runtime-layer-state.ts`).

### apps/bridge/src/services/graphics/renderer/renderer-config-schema.ts
- Status: step-2 done (new)
- Änderungen: `renderer_configure` Zod-Schema aus Entry ausgelagert.
- Line Count: 36
- Komplexität: niedrig
- SSOT/SRP Analyse: zentrale SSOT für Configure-Payload-Validierung.
- Nächster Refactor: optional gemeinsame IPC-Command-Schemas ergänzen.

### apps/bridge/src/services/graphics/schemas/output-schemas.ts
- Status: step-2 done (new)
- Änderungen: Output-bezogene Schemas/Typen extrahiert.
- Line Count: 79
- Komplexität: niedrig
- SSOT/SRP Analyse: klare Domänentrennung; SRP für Output-Contracts.
- Nächster Refactor: optional output-key-spezifische Validatoren neben Schema gruppieren.

### apps/bridge/src/services/graphics/schemas/layer-schemas.ts
- Status: step-2 done (new)
- Änderungen: Layer-/Preset-bezogene Schemas/Typen extrahiert.
- Line Count: 132
- Komplexität: mittel
- SSOT/SRP Analyse: Layer-Contracts sind konsolidiert und unabhängig von Output-Contracts.
- Nächster Refactor: optional Preset-Schemas separat, falls Preset-Logik wächst.

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
