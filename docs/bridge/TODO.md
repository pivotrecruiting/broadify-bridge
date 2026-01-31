# Dokumentations-TODO – Bridge

Ziel: Vollständige interne Dokumentation der Bridge inkl. Graphics-Flow, Device-Module und Helper-Integration. Alle Punkte sind in Stufen gegliedert und sollten nacheinander abgeschlossen werden.

## Stufe 1 – Architektur & Struktur (High-Level)
- [x] Kurzüberblick: Zweck der Bridge, Verantwortlichkeiten, Grenzen
- [x] Architekturdiagramm (Mermaid): Server, Relay, Graphics, Device-Module, Helper
- [x] Datenflüsse (Text + Mermaid): Command-Ingress → Graphics-Pipeline → Output
- [x] Security-Zonen & Trust-Boundaries (Netzwerk, IPC, Helper)
- [x] Projektstruktur-Guide (Ordner, Laufzeit-Komponenten)

## Stufe 2 – Subsysteme (Mid-Level)
- [x] Fastify-Server & Routes (Status, Outputs, WebSocket, Relay)
- [x] Relay-Client & Command-Router (Command-Handling, Results)
- [x] Graphics-Manager (Layer, Presets, Ticker, Output)
- [x] Renderer-Client (IPC-Protokoll, Handshake, Limits)
- [x] Electron Graphics Renderer (Offscreen, Frame-Capture, Asset-Protocol)
- [x] Output-Adapter (DeckLink Video, Key/Fill, Split, Stub)
- [x] Device-Discovery (Module-Registry, Cache, Watcher)
- [x] DeckLink Helper Integration (List/Watch/Modes)
- [x] Config & Persistence (UserData, Output-Config, Assets)
- [x] Logging & Fehlerbehandlung (pino/console, Throttling)

## Stufe 3 – Features (Deep-Dive)
- [x] Graphics-Commands: Payloads, Validierung, Fehlerbilder
- [x] Output-Konfiguration: Targets, Formats, Pixel-Policy
- [x] Asset-Management: Store, Limits, asset://-Auflösung
- [x] Template-Sicherheit: Sanitizing, Binding-Regeln
- [x] Preset-Queue & Expiry-Mechanik
- [ ] Device-Outputs: Port-Model, Availability, Modes
- [ ] Relay-Protokoll: command/command_result/bridge_hello

## Stufe 4 – Wichtige Dateien (Low-Level Referenzen)
- [x] `apps/bridge/src/server.ts`
- [x] `apps/bridge/src/services/command-router.ts`
- [x] `apps/bridge/src/services/relay-client.ts`
- [x] `apps/bridge/src/services/graphics/graphics-manager.ts`
- [x] `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- [x] `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- [x] `apps/bridge/src/services/graphics/output-adapters/*`
- [ ] `apps/bridge/src/modules/decklink/*`
- [ ] `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`

## Stufe 5 – Betrieb & Entwicklung
- [ ] Build/Run (Dev/Prod), benötigte Binaries
- [ ] Environment-Variablen & Flags
- [ ] Troubleshooting & Debug-Checkliste (Graphics/Device/Relay)
- [ ] Logs, Log-Speicherorte, Rotationsstrategie
- [ ] Packaging-Details für Helper (Deploy/Paths)

## Abnahmekriterien (Definition of Done)
- [ ] Jede Stufe hat eigene `.md` Dateien in `docs/bridge/`
- [x] Alle Diagramme sind als Mermaid enthalten
- [x] Alle Security-Risiken sind explizit benannt + Mitigations
- [x] File-Referenzen enthalten Zweck, Ein-/Ausgänge, Abhängigkeiten
