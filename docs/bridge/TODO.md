# Dokumentations-TODO – Bridge

Ziel: Vollständige interne Dokumentation der Bridge inkl. Graphics-Flow, Device-Module und Helper-Integration. Alle Punkte sind in Stufen gegliedert und sollten nacheinander abgeschlossen werden.

## Stufe 1 – Architektur & Struktur (High-Level)
- [ ] Kurzüberblick: Zweck der Bridge, Verantwortlichkeiten, Grenzen
- [ ] Architekturdiagramm (Mermaid): Server, Relay, Graphics, Device-Module, Helper
- [ ] Datenflüsse (Text + Mermaid): Command-Ingress → Graphics-Pipeline → Output
- [ ] Security-Zonen & Trust-Boundaries (Netzwerk, IPC, Helper)
- [ ] Projektstruktur-Guide (Ordner, Laufzeit-Komponenten)

## Stufe 2 – Subsysteme (Mid-Level)
- [ ] Fastify-Server & Routes (Status, Outputs, WebSocket, Relay)
- [ ] Relay-Client & Command-Router (Command-Handling, Results)
- [ ] Graphics-Manager (Layer, Presets, Ticker, Output)
- [ ] Renderer-Client (IPC-Protokoll, Handshake, Limits)
- [ ] Electron Graphics Renderer (Offscreen, Frame-Capture, Asset-Protocol)
- [ ] Output-Adapter (DeckLink Video, Key/Fill, Split, Stub)
- [ ] Device-Discovery (Module-Registry, Cache, Watcher)
- [ ] DeckLink Helper Integration (List/Watch/Modes)
- [ ] Config & Persistence (UserData, Output-Config, Assets)
- [ ] Logging & Fehlerbehandlung (pino/console, Throttling)

## Stufe 3 – Features (Deep-Dive)
- [ ] Graphics-Commands: Payloads, Validierung, Fehlerbilder
- [ ] Output-Konfiguration: Targets, Formats, Pixel-Policy
- [ ] Asset-Management: Store, Limits, asset://-Auflösung
- [ ] Template-Sicherheit: Sanitizing, Binding-Regeln
- [ ] Preset-Queue & Expiry-Mechanik
- [ ] Device-Outputs: Port-Model, Availability, Modes
- [ ] Relay-Protokoll: command/command_result/bridge_hello

## Stufe 4 – Wichtige Dateien (Low-Level Referenzen)
- [ ] `apps/bridge/src/server.ts`
- [ ] `apps/bridge/src/services/command-router.ts`
- [ ] `apps/bridge/src/services/relay-client.ts`
- [ ] `apps/bridge/src/services/graphics/graphics-manager.ts`
- [ ] `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- [ ] `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- [ ] `apps/bridge/src/services/graphics/output-adapters/*`
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
- [ ] Alle Diagramme sind als Mermaid enthalten
- [ ] Alle Security-Risiken sind explizit benannt + Mitigations
- [ ] File-Referenzen enthalten Zweck, Ein-/Ausgänge, Abhängigkeiten
