# Dokumentations-TODO – Desktop App (Electron + UI)

Ziel: Vollständige interne Dokumentation der Desktop-App inkl. Main/Preload/Renderer, IPC, Bridge-Steuerung und UI-Flows.

## Stufe 1 – Architektur & Struktur (High-Level)
- [x] Kurzüberblick: Zweck der Desktop-App, Verantwortlichkeiten, Grenzen
- [x] Architekturdiagramm (Mermaid): Main, Preload, Renderer, Bridge-Prozess
- [x] Datenflüsse (Text + Mermaid): UI → Preload → Main → Bridge
- [x] Security-Zonen (Renderer-Sandbox, IPC, Datei/OS-Zugriff)
- [x] Projektstruktur-Guide (Ordner, Laufzeit-Entry Points)

## Stufe 2 – Subsysteme (Mid-Level)
- [x] Main Process: Window/Tray, Lifecycle, Bridge-Start/Stop
- [x] Preload: exposed API, Channel-Whitelist, Validation
- [x] Renderer UI: App-Struktur, State, Hooks, Views
- [x] IPC-Flow: Channels, Payloads, Errors
- [x] Bridge-Integration: Healthcheck, Status, Outputs
- [x] Logging & Error-Handling im Desktop

## Stufe 3 – Features (Deep-Dive)
- [ ] Bridge Control (Start/Stop, Status, Logs)
- [ ] Output-Auswahl & Konfiguration
- [ ] Engine-Integration (Macos/Status/Macros)
- [ ] Network-Config & Port-Checks
- [ ] UI-Statusanzeigen + Fehlerzustände

## Stufe 4 – Wichtige Dateien (Low-Level Referenzen)
- [x] `src/electron/main.ts`
- [x] `src/electron/preload.cts`
- [x] `src/electron/services/bridge-process-manager.ts`
- [x] `src/electron/services/bridge-health-check.ts`
- [x] `src/electron/services/bridge-outputs.ts`
- [x] `src/electron/services/app-logs.ts`
- [x] `src/ui/App.tsx`
- [x] `src/ui/main.tsx`
- [x] `src/ui/hooks/*`
- [x] `src/ui/components/*`

## Stufe 5 – Betrieb & Entwicklung
- [ ] Build/Run (Vite, electron-vite), Dev vs Prod
- [ ] Environment-Variablen & Flags
- [ ] Troubleshooting & Debug-Checkliste (IPC/Bridge/Renderer)
- [ ] Packaging/Updater-Readiness (electron-builder, electron-updater)

## Abnahmekriterien (Definition of Done)
- [x] Jede Stufe hat eigene `.md` Dateien in `docs/desktop/`
- [x] Alle Diagramme sind als Mermaid enthalten
- [x] Security-Risiken sind explizit benannt + Mitigations
- [x] File-Referenzen enthalten Zweck, Ein-/Ausgänge, Abhängigkeiten
