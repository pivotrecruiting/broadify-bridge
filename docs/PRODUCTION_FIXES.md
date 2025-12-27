# Production Fixes - Bridge Start & Sentry CSP

## Geänderte Dateien

### 1. `electron-builder.json`
- `asarUnpack: ["bridge/**"]` hinzugefügt

### 2. `src/electron/services/bridge-process-manager.ts`
- `--runAsNode` Flag aus `getBridgeArgs()` entfernt
- `ELECTRON_RUN_AS_NODE=1` als Environment Variable in `spawn()` hinzugefügt
- `env` als `Record<string, string>` typisiert (TypeScript-Fix)
- Production-Logging implementiert:
  - Log-Datei: `bridge-process.log` in `app.getPath('userData')`
  - stdout/stderr werden in Log-Datei geschrieben
  - Log-Stream wird beim Stop geschlossen

### 3. `src/electron/main.ts`
- Sentry im Main Process initialisiert (vor `app.on('ready')`)
- Single Instance Lock implementiert:
  - `app.requestSingleInstanceLock()` vor `app.on('ready')`
  - `app.on('second-instance')` Event Handler
  - `app.on('open-url')` Event Handler für macOS
- `mainWindow` als globale Variable deklariert
- Null-Checks für `mainWindow` hinzugefügt (TypeScript-Fix)

### 4. `index.html`
- CSP `connect-src` erweitert:
  - `sentry-ipc:` (für Sentry IPC)
  - `https://*.ingest.sentry.io` (für Sentry ingest)

## Behobene Probleme

1. **Bridge startet neue Electron-Instanz**
   - Fix: `ELECTRON_RUN_AS_NODE=1` Environment Variable statt `--runAsNode` Flag
   - Fix: `asarUnpack` für Bridge-Dateien

2. **Zweite App öffnet sich bei "Launch GUI"**
   - Fix: Single Instance Lock implementiert

3. **Sentry CSP Fehler**
   - Fix: Sentry im Main Process initialisiert
   - Fix: CSP `connect-src` erweitert

