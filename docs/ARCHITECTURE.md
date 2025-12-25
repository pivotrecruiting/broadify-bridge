# Architektur-Übersicht

## Überblick

Broadify Bridge v2 ist eine Electron-basierte Desktop-Anwendung, die einen lokalen Bridge-Server verwaltet. Die Anwendung besteht aus drei Hauptkomponenten:

1. **Desktop App (Electron)** - Hauptanwendung mit UI
2. **Bridge Process** - Separater Node.js-Server-Prozess
3. **Renderer (React UI)** - Benutzeroberfläche

## Architektur-Diagramm

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop App (Electron)                    │
│                                                               │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  Main Process    │         │  Preload Script  │          │
│  │  (Node.js)       │◄────────┤  (Bridge)        │          │
│  │                  │         │                  │          │
│  │  - Bridge        │         │  - contextBridge │          │
│  │    Manager       │         │  - IPC Expose    │          │
│  │  - Health Check  │         └──────────────────┘          │
│  │  - Network      │                  │                    │
│  │    Detection    │                  │ IPC                │
│  └──────────────────┘                  │                    │
│         │                               │                    │
│         │ spawn                         │                    │
│         │                               │                    │
│         ▼                               ▼                    │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  Bridge Process  │         │  Renderer        │          │
│  │  (Child Process) │         │  (React UI)       │          │
│  │                  │         │                  │          │
│  │  - Fastify       │         │  - Components     │          │
│  │  - HTTP Server   │         │  - Hooks         │          │
│  │  - Status API    │         │  - State         │          │
│  └──────────────────┘         └──────────────────┘          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Sicherheitszonen

Die Anwendung folgt dem **Security Boundary Pattern** mit strikter Trennung:

### 1. Main Process (`src/electron/main.ts`)

- **Zugriff:** Vollständiger Node.js-Zugriff, OS-APIs
- **Aufgaben:**
  - Bridge-Prozess starten/stoppen
  - Netzwerk-Interfaces erkennen
  - Port-Verfügbarkeit prüfen
  - Health Checks durchführen
  - Fenster-Management

### 2. Preload (`src/electron/preload.cts`)

- **Zugriff:** Eingeschränkt, nur `contextBridge`
- **Aufgaben:**
  - IPC-Kommunikation zwischen Renderer und Main
  - Exponiert nur whitelisted APIs via `window.electron.*`
  - Keine direkten Node-APIs im Renderer

### 3. Renderer (`src/ui/`)

- **Zugriff:** Keine Node-APIs, nur Browser-APIs
- **Aufgaben:**
  - React UI rendern
  - Benutzerinteraktionen
  - Kommunikation nur über `window.electron.*`

### 4. Bridge (`apps/bridge/`)

- **Zugriff:** Node.js, aber isoliert als separater Prozess
- **Aufgaben:**
  - HTTP-Server (Fastify)
  - Status-Endpoint bereitstellen
  - Zukünftig: Device-Module, Cloud-Tunnel, LAN-Server

## Datenfluss

### Bridge Starten

```
Renderer (UI)
    │
    │ window.electron.bridgeStart(config)
    ▼
Preload (IPC)
    │
    │ ipcRenderer.invoke('bridgeStart', config)
    ▼
Main Process
    │
    │ bridgeProcessManager.start(config)
    ▼
Bridge Process (spawn)
    │
    │ HTTP Server startet
    ▼
Health Check Polling
    │
    │ Status Updates via IPC
    ▼
Renderer (UI Update)
```

### Status Updates

```
Bridge Process
    │
    │ HTTP GET /status
    ▼
Main Process (Health Check)
    │
    │ ipcWebContentsSend('bridgeStatus', status)
    ▼
Preload (IPC Event)
    │
    │ window.electron.subscribeBridgeStatus(callback)
    ▼
Renderer (UI Update)
```

## Konfiguration

### Network Config

- **Template:** `config/network-config.json` (im Projekt)
- **User Config:** `app.getPath('userData')/network-config.json` (persistiert)
- **Fallback:** Hardcoded `DEFAULT_NETWORK_CONFIG` in `main.ts`

### Bridge Config

- Wird als CLI-Argumente an Bridge-Prozess übergeben
- Format: `--host <ip> --port <port>`
- Bridge validiert mit Zod-Schema

## Build-Prozess

### Development

```
npm run dev
    ├── dev:react (Vite Dev Server auf Port 5173)
    └── dev:electron (Electron startet, lädt http://localhost:5173)
```

### Production Build

```
npm run build
    ├── transpile:electron (TypeScript → JavaScript)
    ├── vite build (React → dist-react/)
    └── electron-builder (Packaging)
```

## Abhängigkeiten

### Desktop App

- **Electron** - Desktop-Framework
- **React 19** - UI-Framework
- **TypeScript** - Type Safety
- **Vite** - Build Tool
- **Tailwind CSS** - Styling

### Bridge

- **Fastify** - HTTP Server
- **pino** - Logging
- **Zod** - Config Validation

## Weitere Dokumentation

- [Main Process](./MAIN_PROCESS.md) - Detaillierte Main Process Dokumentation
- [Renderer](./RENDERER.md) - UI-Komponenten und Hooks
- [Bridge](./BRIDGE.md) - Bridge-Server Dokumentation
- [IPC Communication](./IPC_COMMUNICATION.md) - IPC-Protokoll
- [Config Management](./CONFIG_MANAGEMENT.md) - Konfigurationssystem
- [Services](./SERVICES.md) - Service-Module
