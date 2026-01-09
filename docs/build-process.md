# Build-Prozess Dokumentation

## Übersicht

Dieses Dokument beschreibt den vollständigen Build-Prozess für die Broadify Bridge.

## Build-Abhängigkeiten

### Erforderliche Tools

- **Node.js:** >= 22.12
- **npm:** Latest
- **TypeScript:** ~5.7.2

## Build-Schritte

### 1. Dependencies installieren

```bash
# Root-Dependencies
npm install

# Bridge-Dependencies
cd apps/bridge
npm install
cd ../..
```

### 2. TypeScript kompilieren

```bash
# Electron Main/Preload
npm run transpile:electron

# Bridge
npm run build:bridge

# Graphics Renderer
npm run build:graphics-renderer
```

### 3. React App bauen

```bash
npm run build:app
```

### 4. Electron App packen

```bash
# macOS (ARM64)
npm run dist:mac:arm64

# macOS (x64)
npm run dist:mac:x64

# Windows
npm run dist:win

# Linux
npm run dist:linux

# Alle Plattformen
npm run dist:all
```

## Build-Konfiguration

### `electron-builder.json`

Definiert Electron-Builder Konfiguration.

### `package.json`

Definiert Build-Scripts.

## Troubleshooting

### Problem: Build schlägt fehl

**Lösung:**

1. Prüfe Node.js Version: `node --version` (>= 22.12)
2. Prüfe Dependencies: `npm install`
3. Prüfe TypeScript: `npm run transpile:electron`
4. Prüfe Logs für Fehlermeldungen

## Nächste Schritte

1. ⏳ Automatische Lizenz-Checks implementieren
2. ⏳ CI/CD Integration für automatische Builds
