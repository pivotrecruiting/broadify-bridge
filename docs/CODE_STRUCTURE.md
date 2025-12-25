# Broadify Bridge v2 - Code-Struktur Dokumentation

## Übersicht

Diese Dokumentation beschreibt die aktuelle Code-Struktur der Broadify Bridge v2, einschließlich aller Komponenten, Services und deren Interaktionen.

## Projekt-Struktur

```
broadify-bridge-v2/
├── apps/
│   └── bridge/                    # Bridge Process (separater Node.js Server)
│       ├── src/
│       │   ├── index.ts          # Entry Point
│       │   ├── config.ts         # Config Parsing & Validation
│       │   ├── server.ts         # Fastify Server Setup
│       │   └── routes/
│       │       ├── status.ts     # GET /status Endpoint
│       │       └── outputs.ts    # GET /outputs Endpoint
│       └── package.json
│
├── src/
│   ├── electron/                  # Electron Main Process
│   │   ├── main.ts               # Haupt-Entry Point
│   │   ├── preload.cts           # IPC Bridge (contextBridge)
│   │   ├── pathResolver.ts       # Pfad-Auflösung Dev/Prod
│   │   ├── util.ts               # Hilfsfunktionen
│   │   └── services/
│   │       ├── bridge-process-manager.ts    # Bridge Prozess-Verwaltung
│   │       ├── bridge-health-check.ts       # Health Check Polling
│   │       ├── bridge-outputs.ts            # Bridge Outputs Fetching
│   │       ├── device-detector.ts            # Device-Erkennung (Main Process)
│   │       ├── network-interface-detector.ts # Netzwerk-Interface-Erkennung
│   │       └── port-checker.ts              # Port-Verfügbarkeit
│   │
│   └── ui/                        # React Renderer (UI)
│       ├── App.tsx               # Haupt-Komponente
│       ├── components/           # UI Komponenten
│       ├── hooks/                # React Hooks
│       ├── constants/            # Konstanten
│       └── utils/                # Utility Funktionen
│
├── config/
│   └── network-config.json       # Network Config Template
│
├── docs/                          # Dokumentation
│   ├── ARCHITECTURE.md
│   ├── BRIDGE.md
│   ├── MAIN_PROCESS.md
│   ├── IPC_COMMUNICATION.md
│   └── ...
│
└── types.d.ts                     # TypeScript Type Definitions
```

---

## Bridge Process (`apps/bridge/`)

### Entry Point: `src/index.ts`

**Funktion**: Startet den Bridge-Server

```typescript
async function main() {
  const args = process.argv.slice(2);
  const config = parseConfig(args); // Zod validation
  const server = await createServer(config);
  await startServer(server, config);
}
```

**CLI Arguments**:

- `--host <ip>` - IP-Adresse zum Binden (z.B. `127.0.0.1`, `0.0.0.0`)
- `--port <number>` - Port-Nummer (z.B. `8787`)

### Config: `src/config.ts`

**Zod Schema**:

```typescript
const ConfigSchema = z.object({
  host: z.string().ip({ version: "v4" }),
  port: z.number().int().min(1).max(65535),
  mode: z.enum(["lan", "local"]),
});
```

**Mode-Derivation**:

- `host === "0.0.0.0"` → `mode: "lan"`
- `host === "127.0.0.1"` → `mode: "local"`
- Andere IPs → `mode: "lan"`

### Server: `src/server.ts`

**Funktionen**:

- `createServer()` - Erstellt Fastify Server mit Routes
- `startServer()` - Startet Server mit Error Handling

**Routes**:

- `registerStatusRoute` - GET /status
- `registerOutputsRoute` - GET /outputs

**Graceful Shutdown**:

- SIGTERM/SIGINT Handler
- Server schließt sauber

### Routes

#### `src/routes/status.ts`

**Endpoint**: `GET /status`

**Response**:

```json
{
  "running": true,
  "version": "0.1.0",
  "uptime": 12345,
  "mode": "local",
  "port": 8787,
  "host": "127.0.0.1"
}
```

#### `src/routes/outputs.ts`

**Endpoint**: `GET /outputs`

**Response**:

```json
{
  "output1": [
    {
      "id": "hdmi-decklink",
      "name": "HDMI Decklink Card",
      "type": "decklink",
      "available": true
    }
  ],
  "output2": [
    {
      "id": "sdi",
      "name": "SDI",
      "type": "connection",
      "available": true
    }
  ]
}
```

**Status**: Gibt aktuell leere Arrays zurück (keine Mock-Daten, Device-Module noch nicht implementiert)

---

## Electron Main Process (`src/electron/`)

### Entry Point: `main.ts`

**Hauptfunktionen**:

- App-Initialisierung
- IPC-Handler-Registrierung
- Bridge-Lifecycle-Management
- Window-Management

**State-Management**:

```typescript
let healthCheckCleanup: (() => void) | null = null;
let bridgeOutputs: { output1: string; output2: string } | null = null;
let currentNetworkBindingId: string | null = null;
let hasOpenedWebApp = false;
```

### IPC Handler

#### Bridge-Kommandos

**`bridgeStart`**:

- Startet Bridge-Prozess
- Startet Health Check Polling
- Sendet initialen Status

**`bridgeStop`**:

- Stoppt Health Check
- Stoppt Bridge-Prozess
- Sendet finalen Status

**`bridgeGetStatus`**:

- Prüft ob Prozess läuft
- Führt Health Check durch

**`bridgeGetOutputs`**:

- Wenn Bridge läuft: Outputs von Bridge abrufen
- Wenn Bridge nicht läuft: Device-Erkennung im Main Process

#### Port-Checking

**`checkPortAvailability`**:

- Prüft einzelnen Port

**`checkPortsAvailability`**:

- Prüft mehrere Ports parallel (Batches von 10)

#### Network-Config

**`getNetworkConfig`**:

- Lädt Network Config (User Data → Template → Default)

**`detectNetworkInterfaces`**:

- Erkennt verfügbare Netzwerk-Interfaces

**`getNetworkBindingOptions`**:

- Wie `detectNetworkInterfaces`, konsistenter Name

### Services

#### `bridge-process-manager.ts`

**Klasse**: `BridgeProcessManager`

**Funktionen**:

- `start(config, autoFindPort)` - Startet Bridge-Prozess
- `stop()` - Stoppt Bridge-Prozess (SIGTERM → SIGKILL)
- `isRunning()` - Prüft ob Prozess läuft
- `getConfig()` - Gibt aktuelle Config zurück

**Features**:

- Automatisches Port-Finding wenn Port belegt
- Process stdout/stderr Logging
- Graceful Shutdown mit Timeout

#### `bridge-health-check.ts`

**Funktionen**:

- `checkBridgeHealth(config)` - Einzelner Health Check
- `startHealthCheckPolling(config, callback, isRunning)` - Polling alle 2 Sekunden

**Features**:

- Timeout nach 3 Sekunden
- Error Detection (Nicht-JSON Response = Port belegt)
- Status-Updates via IPC

#### `bridge-outputs.ts`

**Funktionen**:

- `fetchBridgeOutputs(config)` - Ruft Outputs von Bridge ab

**Features**:

- Timeout nach 5 Sekunden
- Error Handling
- Logging mit `[OutputChecker]` Präfix

#### `device-detector.ts`

**Funktionen**:

- `discoverOutputs()` - Erkennt Devices im Main Process

**Status**: Gibt aktuell leere Arrays zurück (Device-Module noch nicht implementiert)

**Zweck**: Device-Erkennung vor Bridge-Start ermöglichen

#### `network-interface-detector.ts`

**Funktionen**:

- `detectNetworkInterfaces(configOptions, filters)` - Erkennt Netzwerk-Interfaces
- `resolveBindAddress(bindAddress, interfaceType, filters)` - Resolved AUTO_IPV4

**Features**:

- Filtert ausgeschlossene Interfaces (docker, vbox, etc.)
- IPv4/IPv6 Support
- IP-Range Filtering

#### `port-checker.ts`

**Funktionen**:

- `isPortAvailable(port, host)` - Prüft einzelnen Port
- `findAvailablePort(startPort, maxPort, host)` - Findet nächsten verfügbaren Port
- `checkPortsAvailability(ports, host)` - Prüft mehrere Ports parallel

**Features**:

- Timeout nach 2 Sekunden
- Batch-Processing (10 Ports parallel)
- Error Handling (EADDRINUSE)

### Preload: `preload.cts`

**Funktion**: IPC Bridge zwischen Renderer und Main Process

**Exposed APIs**:

```typescript
window.electron = {
  // Subscriptions
  subscribeStatistics: (callback) => UnsubscribeFunction,
  subscribeBridgeStatus: (callback) => UnsubscribeFunction,

  // Commands
  getStaticData: () => Promise<StaticData>,
  bridgeStart: (config: BridgeConfig) => Promise<{...}>,
  bridgeStop: () => Promise<{...}>,
  bridgeGetStatus: () => Promise<BridgeStatus>,
  bridgeGetOutputs: () => Promise<BridgeOutputsT>,

  // Port Checking
  checkPortAvailability: (port: number, host?: string) => Promise<PortAvailability>,
  checkPortsAvailability: (ports: number[], host?: string) => Promise<PortAvailability[]>,

  // Network Config
  getNetworkConfig: () => Promise<NetworkConfigT>,
  detectNetworkInterfaces: () => Promise<NetworkBindingOptionT[]>,
  getNetworkBindingOptions: () => Promise<NetworkBindingOptionT[]>,
}
```

---

## React Renderer (`src/ui/`)

### Haupt-Komponente: `App.tsx`

**State-Management**:

- Network Config (via `useNetworkConfig`)
- Bridge Status (via `useBridgeStatus`)
- Bridge Outputs (via `useBridgeOutputs`)
- Port Availability (via `usePortAvailability`)
- Engine State (ATEM IP/Port)
- Outputs State (output1, output2)

**Hauptfunktionen**:

- `handleLetsGo()` - Startet Bridge mit Config
- `handleStopServer()` - Stoppt Bridge
- `isStartDisabled()` - Validiert Inputs vor Start

### Hooks

#### `use-network-config.ts`

**Funktionen**:

- Lädt Network Config
- Verwaltet Network Binding ID
- Verwaltet Port Selection (Standard/Custom)
- Verwaltet Advanced Mode Toggle

#### `use-bridge-status.ts`

**Funktionen**:

- Abonniert Bridge Status Updates
- Initialer Status-Check beim Mount

#### `use-bridge-outputs.ts`

**Funktionen**:

- Ruft Outputs ab (via `bridgeGetOutputs`)
- Verwaltet Loading/Error States
- Refetch-Funktion für Updates

#### `use-port-availability.ts`

**Funktionen**:

- Prüft Port-Verfügbarkeit
- Batch-Checking für mehrere Ports
- Custom Port Checking

#### `use-network-binding.ts`

**Funktionen**:

- Verwaltet Network Binding Changes
- Resolved Bind Address
- Port Config Management

### Komponenten

#### `NetworkSection.tsx`

**Props**:

- Network Config
- Network Binding Options
- Port Availability
- Bridge Status
- Callbacks für Changes

**Features**:

- Interface Selector
- Port Selector
- Advanced Mode Toggle

#### `EngineSection.tsx`

**Props**:

- Engine ATEM (IP)
- Engine Port
- Callbacks für Changes

**Status**: Config wird aktuell nicht an Bridge übergeben

#### `OutputsSection.tsx`

**Props**:

- Output1/Output2 Selection
- Output Options (dynamisch von Bridge)
- Loading State
- Callbacks für Changes

**Features**:

- Zeigt nur verfügbare Outputs
- Disabled State wenn Bridge läuft

#### `BridgeControlButton.tsx`

**Props**:

- Bridge Status
- Loading States (Starting/Stopping)
- Disabled State
- Callbacks (onStart/onStop)

---

## Type Definitions (`types.d.ts`)

### BridgeConfig

```typescript
export type BridgeConfig = {
  host: string;
  port: number;
  outputs?: {
    output1: string;
    output2: string;
  };
  networkBindingId?: string;
};
```

**Hinweis**: Engine Config fehlt noch (geplant für Phase 1)

### BridgeStatus

```typescript
export type BridgeStatus = {
  running: boolean;
  reachable: boolean;
  version?: string;
  uptime?: number;
  mode?: string;
  port?: number;
  host?: string;
  error?: string;
};
```

### OutputDeviceT

```typescript
export type OutputDeviceT = {
  id: string;
  name: string;
  type: "decklink" | "capture" | "connection";
  available: boolean;
};
```

### NetworkConfigT

```typescript
export type NetworkConfigT = {
  networkBinding: NetworkBindingConfigT;
  port: PortConfigT;
  security: {
    lanMode: {
      enabled: boolean;
      requireAuth: boolean;
      readOnlyWithoutAuth: boolean;
    };
  };
};
```

---

## Datenfluss

### Bridge Start Flow

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

### Output Discovery Flow

```
Renderer (UI)
    │
    │ window.electron.bridgeGetOutputs()
    ▼
Main Process
    │
    ├─ Bridge läuft?
    │  ├─ Ja → fetchBridgeOutputs() → Bridge API
    │  └─ Nein → discoverOutputs() → Device Detection
    ▼
Renderer (UI Update)
```

---

## Logging-Konventionen

Alle Logs verwenden Präfixe:

- `[Bridge]` - Bridge-Prozess Output
- `[BridgeManager]` - Process Manager
- `[HealthCheck]` - Health Check
- `[OutputChecker]` - Output Detection/Fetching
- `[NetworkConfig]` - Config Loading
- `[PortChecker]` - Port Checks (entfernt, keine Logs mehr)

---

## Konfiguration

### Network Config

**Priorität**:

1. User Data Config (`app.getPath('userData')/network-config.json`)
2. Template Config (`config/network-config.json`)
3. Hardcoded Default (`DEFAULT_NETWORK_CONFIG`)

### Bridge Config

**Übergabe**: CLI Arguments

- `--host <ip>`
- `--port <number>`

**Validierung**: Zod Schema

---

## Build & Development

### Development

```bash
npm run dev
    ├── dev:react (Vite Dev Server auf Port 5173)
    └── dev:electron (Electron startet, lädt http://localhost:5173)
```

### Bridge Development

```bash
cd apps/bridge
npm run dev
# Oder: npm run dev:lan (für LAN-Mode)
```

### Production Build

```bash
npm run build
    ├── transpile:electron (TypeScript → JavaScript)
    ├── vite build (React → dist-react/)
    └── electron-builder (Packaging)
```

---

## Dependencies

### Desktop App

- **Electron** - Desktop-Framework
- **React 19** - UI-Framework
- **TypeScript** - Type Safety
- **Vite** - Build Tool
- **Tailwind CSS** - Styling

### Bridge

- **Fastify** - HTTP Server Framework
- **pino** - Logging
- **zod** - Config Validation

---

## Bekannte Limitationen

1. **Device-Erkennung**: Gibt aktuell leere Arrays zurück (Device-Module noch nicht implementiert)
2. **Engine Config**: Wird nicht an Bridge übergeben (geplant für Phase 1)
3. **ATEM/Tricaster**: Noch nicht integriert (geplant für Phase 3)
4. **Hardware Output**: Noch nicht implementiert (geplant für Phase 2)

---

## Weitere Dokumentation

- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
- [Bridge](./BRIDGE.md) - Bridge-Server Details
- [Main Process](./MAIN_PROCESS.md) - Main Process Details
- [IPC Communication](./IPC_COMMUNICATION.md) - IPC-Protokoll
- [Config Management](./CONFIG_MANAGEMENT.md) - Config-System
- [Services](./SERVICES.md) - Service-Module Details
- [ATEM/Tricaster Requirements](./ATEM_TRICASTER_REQUIREMENTS.md) - Anforderungen für ATEM/Tricaster Integration
