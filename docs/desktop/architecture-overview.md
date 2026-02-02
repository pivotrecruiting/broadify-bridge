# Desktop App – Architektur & Struktur (Stufe 1)

## Checkliste Stufe 1
- [ ] Kurzüberblick abgeschlossen
- [ ] Architekturdiagramm verifiziert
- [ ] Datenflüsse beschrieben
- [ ] Security-Boundaries dokumentiert
- [ ] Projektstruktur beschrieben

## Kurzüberblick
Die Desktop-App ist eine Electron-Anwendung, die die Bridge lokal startet/stoppt, Status anzeigt und Netzwerk-/Port-Optionen verwaltet. Sie besteht aus Main Process (Backend), Preload (IPC-Bridge) und Renderer UI (React).

## Hauptkomponenten (Runtime)
- Main Process: App-Lifecycle, Fenster, Bridge-Start/Stop, IPC-Handlers
- Preload: sichere API-Expose via `contextBridge`
- Renderer UI: React UI, Hook-basierte State-Logik
- Bridge Process Manager: startet Bridge (dev: `npx tsx`, prod: Electron als Node)

## Architekturdiagramm (Mermaid)
```mermaid
flowchart LR
  UI[Renderer UI (React)] -->|window.electron.*| Preload
  Preload -->|IPC invoke/on| Main
  Main --> BridgeProcessManager
  BridgeProcessManager --> BridgeProcess
  Main -->|HTTP| BridgeAPI
  Main -->|Status events| UI
```

## Zentrale Datenflüsse
### 1) Bridge Start/Stop
1. UI ruft `window.electron.bridgeStart()`.
2. Preload delegiert an `ipcMainHandle`.
3. Main resolvt Config + Network Binding, startet Bridge Process.
4. Health-Check Polling liefert Status an UI.

### 2) Status & Logs
1. UI subscribed auf `bridgeStatus`.
2. Main sendet Status via `ipcWebContentsSend`.
3. Logs werden via `bridgeGetLogs`/`appGetLogs` abgeholt.

### 3) Engine-Commands
1. UI ruft `engineConnect/RunMacro` etc.
2. Main führt HTTP Requests an Bridge `/engine/*` aus.
3. Ergebnis wird an UI zurückgegeben.

## Security-Boundaries
- Renderer ↔ Main: nur via Preload-API; Renderer nutzt keine Node-APIs.
- Main ↔ Bridge: lokale HTTP-Calls; Timeouts/Fehlerhandling implementiert.
- BrowserWindow: `webPreferences` setzt derzeit nur `preload`; weitere Security-Flags sind nicht explizit gesetzt (prüfen).

## Projektstruktur (relevant)
- Main: `src/electron/main.ts`
- Preload: `src/electron/preload.cts`
- Services: `src/electron/services/*`
- UI: `src/ui/*`

## Offene Punkte
- Security-Flags im BrowserWindow verifizieren
- Detaillierte IPC-Channel-Liste inkl. Payloads
- Packaging/Updater-Vorbereitung (electron-builder)
