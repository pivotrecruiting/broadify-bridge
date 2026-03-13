# Desktop App – Dataflows (Aktueller Stand)

## Zweck
Diese Datei beschreibt die aktuellen End-to-End Flows der Electron Desktop App (Renderer, Preload, Main, Bridge).

## 1) App-Startup und Main-Initialisierung
```mermaid
sequenceDiagram
  participant App as Electron Runtime
  participant Main as main.ts
  participant Win as BrowserWindow
  participant UI as Renderer UI

  App->>Main: app ready
  Main->>Main: single-instance lock + Sentry init
  Main->>Win: create BrowserWindow(preload)
  Main->>UI: loadURL/loadFile
  Main->>Main: register IPC handlers
```

Wesentliche Punkte:
- `main.ts` hat einen separaten Aux-Mode fuer `--graphics-renderer` (Renderer-Subprozess).
- Desktop-Hauptprozess verwendet Single-Instance-Lock und fokussiert existierende Fenster bei Zweitstart.

## 2) Bridge Start -> Health -> Status Events
```mermaid
sequenceDiagram
  participant UI as React UI
  participant Preload as preload.cts
  participant Main as main.ts
  participant BPM as BridgeProcessManager
  participant Bridge as Bridge HTTP

  UI->>Preload: bridgeStart(config)
  Preload->>Main: ipc invoke bridgeStart
  Main->>Main: terms/name checks + pairing create
  Main->>BPM: start(config,...)
  BPM-->>Main: success/actualPort
  Main->>Bridge: start health polling (/status + /relay/status)
  Main-->>Preload: bridgeStatus event
  Preload-->>UI: subscribeBridgeStatus callback
```

Wesentliche Punkte:
- Terms-Akzeptanz und Bridge-Name werden im Main Process erzwungen.
- Pairing-Code wird pro Start erzeugt und als Status-Info an UI uebergeben.
- Bei Host `0.0.0.0` werden lokale HTTP-Checks gegen `127.0.0.1` ausgefuehrt.

## 3) Logs & Diagnose
```mermaid
sequenceDiagram
  participant UI as React UI
  participant Main as Electron Main
  participant AppLog as app-logs.ts
  participant Bridge as Bridge /logs API

  UI->>Main: appGetLogs / appClearLogs
  Main->>AppLog: read/clear app.log
  AppLog-->>Main: response
  Main-->>UI: app logs response

  UI->>Main: bridgeGetLogs / bridgeClearLogs
  Main->>Bridge: GET /logs | POST /logs/clear
  Bridge-->>Main: response
  Main-->>UI: bridge logs response
```

Wesentliche Punkte:
- App-Logs liegen unter `userData/logs/app.log`.
- In Production schreibt der Bridge-Spawn-Pfad zusaetzlich `bridge-process.log`.

## 4) Port-/Netzwerk-Flow
```mermaid
sequenceDiagram
  participant UI as React UI
  participant Main as main.ts
  participant NIC as network-interface-detector.ts
  participant Port as port-checker.ts

  UI->>Main: getNetworkBindingOptions()
  Main->>NIC: detectNetworkInterfaces(...)
  NIC-->>Main: resolved binding options
  Main-->>UI: options

  UI->>Main: checkPortsAvailability(...)
  Main->>Port: check ports
  Port-->>Main: availability map
  Main-->>UI: availability result
```

## 5) Updater-Flow (electron-updater)
```mermaid
sequenceDiagram
  participant UI as React UI
  participant Main as main.ts
  participant Updater as app-updater.ts

  UI->>Main: updaterCheckForUpdates()
  Main->>Updater: checkForUpdates()
  Updater-->>Main: status transitions
  Main-->>UI: updaterStatus event
```

Wesentliche Punkte:
- Auto-Update ist in Dev deaktiviert und wird nur in unterstuetzten packaged Setups aktiviert.
- Status wird als Snapshot + Event-Stream (`subscribeUpdaterStatus`) bereitgestellt.
