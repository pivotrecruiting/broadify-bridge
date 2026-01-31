# Dokumentations-TODO – Desktop App (Electron + UI)

Ziel: Vollständige interne Dokumentation der Desktop-App inkl. Main/Preload/Renderer, IPC, Bridge-Steuerung und UI-Flows.

## Stufe 1 – Architektur & Struktur (High-Level)
- [ ] Kurzüberblick: Zweck der Desktop-App, Verantwortlichkeiten, Grenzen
- [ ] Architekturdiagramm (Mermaid): Main, Preload, Renderer, Bridge-Prozess
- [ ] Datenflüsse (Text + Mermaid): UI → Preload → Main → Bridge
- [ ] Security-Zonen (Renderer-Sandbox, IPC, Datei/OS-Zugriff)
- [ ] Projektstruktur-Guide (Ordner, Laufzeit-Entry Points)

## Stufe 2 – Subsysteme (Mid-Level)
- [ ] Main Process: Window/Tray, Lifecycle, Bridge-Start/Stop
- [ ] Preload: exposed API, Channel-Whitelist, Validation
- [ ] Renderer UI: App-Struktur, State, Hooks, Views
- [ ] IPC-Flow: Channels, Payloads, Errors
- [ ] Bridge-Integration: Healthcheck, Status, Outputs
- [ ] Logging & Error-Handling im Desktop

## Stufe 3 – Features (Deep-Dive)
- [ ] Bridge Control (Start/Stop, Status, Logs)
- [ ] Output-Auswahl & Konfiguration
- [ ] Engine-Integration (Macos/Status/Macros)
- [ ] Network-Config & Port-Checks
- [ ] UI-Statusanzeigen + Fehlerzustände

## Stufe 4 – Wichtige Dateien (Low-Level Referenzen)
- [ ] `src/electron/main.ts`
- [ ] `src/electron/preload.cts`
- [ ] `src/electron/services/bridge-process-manager.ts`
- [ ] `src/electron/services/bridge-health-check.ts`
- [ ] `src/electron/services/bridge-outputs.ts`
- [ ] `src/electron/services/app-logs.ts`
- [ ] `src/ui/App.tsx`
- [ ] `src/ui/main.tsx`
- [ ] `src/ui/hooks/*`
- [ ] `src/ui/components/*`

## Stufe 5 – Betrieb & Entwicklung
- [ ] Build/Run (Vite, electron-vite), Dev vs Prod
- [ ] Environment-Variablen & Flags
- [ ] Troubleshooting & Debug-Checkliste (IPC/Bridge/Renderer)
- [ ] Packaging/Updater-Readiness (electron-builder, electron-updater)

## Abnahmekriterien (Definition of Done)
- [ ] Jede Stufe hat eigene `.md` Dateien in `docs/desktop/`
- [ ] Alle Diagramme sind als Mermaid enthalten
- [ ] Security-Risiken sind explizit benannt + Mitigations
- [ ] File-Referenzen enthalten Zweck, Ein-/Ausgänge, Abhängigkeiten
