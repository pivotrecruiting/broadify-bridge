# Auto-Update Pipeline Plan (Electron)

## Ziel
Die Desktop-App soll Updates direkt in der App erkennen, herunterladen und installiert starten, ohne manuellen Download von der Website.

## Ist-Stand (Projekt)
- Release-Artefakte werden per GitHub Actions gebaut und als GitHub Release-Assets hochgeladen.
- Es gibt noch keine `electron-updater` Integration im Main/Preload/UI.
- Update-Metadaten (`*.yml`) werden bereits erzeugt.
- In `.github/workflows/release.yml` wird `latest-mac.yml` aktuell umbenannt; das ist für Standard-Auto-Update ungünstig.

## Zielbild (High-Level)
- Update-Quelle: GitHub Releases (provider `github`) mit signierten Artefakten.
- Client: `electron-updater` im Main Process.
- UI: Update-Status, Fortschritt, Fehler, Install-Button.
- Rollout: stabiler Kanal (`latest`) plus produktiver Testkanal (`rc`).

## Kritische Entscheidungen (vor Umsetzung final bestätigen)
- Windows-Target: Für sauberes In-App Auto-Update auf Windows auf `nsis` wechseln (statt `portable`/`msi` als primärem Updater-Pfad).
- macOS-Architektur: zunächst arm64-only oder wieder arm64+x64 mit sauberer Metadaten-Strategie.
- Private vs Public Releases: bei privaten Repositories Token-Strategie für Update-Checks definieren.

## To-dos

## Phase 1 - Produktentscheidung und Scope
- [x] Zielplattformen für Auto-Update festlegen (`macOS`, `Windows`, optional `Linux`).
- [x] Windows-Installer-Strategie entscheiden (`nsis` als Update-Pfad, `msi` optional zusätzlicher Download).
- [x] Release-Kanal-Strategie festlegen (`latest` + `rc`).
- [x] UX-Policy definieren: stilles Downloaden vs. expliziter User-Trigger.

## Phase 2 - Build/Publishing vorbereiten
- [x] `electron-builder` `publish`-Konfiguration für GitHub ergänzen (`owner`, `repo`, `releaseType`).
- [x] Sicherstellen, dass `latest.yml`, `latest-mac.yml`, `latest-linux.yml` unverändert als Assets veröffentlicht werden.
- [x] Rename-Logik in `.github/workflows/release.yml` für `latest-mac.yml` entfernen/ersetzen.
- [x] CI-Fluss so anpassen, dass Update-Metadaten und Binärdateien konsistent pro Tag/Release veröffentlicht werden.
- [x] Signing/Notarization als harte Voraussetzung im Release-Workflow belassen (macOS + Windows).

## Phase 3 - Electron Main integrieren
- [x] `electron-updater` Dependency hinzufügen.
- [x] Neues Modul `src/electron/services/app-updater.ts` erstellen (Single Responsibility).
- [x] `autoUpdater` Lifecycle einbauen: `checkForUpdates`, `download-progress`, `update-downloaded`, `error`.
- [x] Check-Strategie implementieren (z. B. beim App-Start + periodisch).
- [x] Safe Defaults setzen (`autoDownload` kontrolliert, `autoInstallOnAppQuit` nach UX-Entscheid).

## Phase 4 - IPC + UI Integration
- [x] Preload API um Updater-Events/Commands erweitern (`window.electron.updater.*`).
- [x] IPC Payloads validieren (Status, Progress, Fehlercodes) und payload limits beachten.
- [x] UI-Komponenten für Update-Banner/Dialog ergänzen.
- [x] UI-Flows umsetzen: "Update verfügbar", "wird geladen", "neu starten zum Installieren".

## Phase 5 - Security und Logging
- [x] Keine Tokens/Secrets in Logs schreiben (Updater-Fehler sanitizen).
- [ ] Strukturierte Updater-Logs via pino etablieren (event, version, channel, state).
- [x] Signatur-/Integritätsfehler klar als Security-Event markieren.

## Phase 6 - QA und Rollout
- [ ] End-to-End Testmatrix definieren: macOS arm64, Windows x64, optional Linux.
- [ ] Testfälle erstellen: Update verfügbar, kein Update, Download-Abbruch, defekte Metadaten, Rollback.
- [ ] Pilot-Rollout mit interner Testergruppe vor breitem Release.
- [ ] Runbook für Support erstellen ("Update hängt", "Signaturfehler", "kein Feed gefunden").

## Technische Touchpoints im Repo
- `electron-builder.json`
- `electron-builder.config.cjs`
- `.github/workflows/release.yml`
- `src/electron/main.ts`
- `src/electron/preload.cts`
- `src/ui/*` (Updater-Status/Interaktion)

## Security-Auswirkungen und Mitigation
- Risiko: Manipulierte Update-Artefakte.
- Mitigation: Code Signing + Notarization/Trusted Signing strikt erzwingen, nur signierte Releases publizieren.
- Risiko: Leaking von Auth-Token bei privaten Feeds.
- Mitigation: keine Tokens im Renderer, keine Token-Ausgabe in Logs, Token nur Main-seitig aus sicherer Quelle.

## Definition of Done
- [ ] App erkennt neue Versionen aus GitHub Releases zuverlässig.
- [ ] Nutzer kann Update in der App herunterladen und installieren.
- [ ] UI zeigt nachvollziehbare Status- und Fehlermeldungen.
- [x] Release-Workflow publiziert korrekte `latest*.yml` Metadaten ohne Umbenennung.
- [x] RC-Tags (`vX.Y.Z-rc.N`) erzeugen downloadbare GitHub Pre-Releases auf separatem Update-Kanal ohne Rollout an `latest`.
- [ ] E2E-Tests für mindestens macOS + Windows erfolgreich.

## Externe Aufgaben
- Nicht-Code Aufgaben sind kompakt in `docs/desktop/auto-update-external-todos.md` dokumentiert.
