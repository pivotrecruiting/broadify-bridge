# Main Process Dokumentation

## Übersicht

Der Main Process (`src/electron/main.ts`) ist der Kern der Electron-Anwendung. Er verwaltet den Bridge-Prozess, führt Health Checks durch und stellt IPC-Handler für die Renderer-Kommunikation bereit.

## Hauptfunktionen

### 1. Bridge-Prozess-Management

Der Main Process startet und stoppt den Bridge-Prozess als Child Process:

```typescript
bridgeProcessManager.start(config)
  → spawn('npx', ['tsx', 'apps/bridge/src/index.ts', '--host', host, '--port', port])
  → Bridge läuft als separater Prozess
```

**Wichtige Details:**

- Port wird automatisch gefunden, falls belegt
- Process stdout/stderr werden geloggt
- Graceful shutdown mit SIGTERM, dann SIGKILL nach 5s

### 2. Health Check Polling

Nach erfolgreichem Bridge-Start wird ein Health Check gestartet:

```typescript
startHealthCheckPolling(config, onStatusUpdate, isProcessRunning)
  → Pollt alle 2 Sekunden http://host:port/status
  → Sendet Status-Updates via IPC an Renderer
```

**Status-Update-Flow:**

```
Health Check (alle 2s)
  → GET /status
  → BridgeStatus
  → ipcWebContentsSend('bridgeStatus', status)
  → Renderer aktualisiert UI
```

### 3. Netzwerk-Konfiguration

#### Config-Loading (`loadNetworkConfig()`)

**Priorität:**

1. User Data Config (`app.getPath('userData')/network-config.json`)
2. Template Config (`config/network-config.json`) - wird beim ersten Start kopiert
3. Hardcoded Default (`DEFAULT_NETWORK_CONFIG`)

#### Netzwerk-Interface-Erkennung

```typescript
detectNetworkInterfaces(configOptions, filters)
  → Liest os.networkInterfaces()
  → Filtert ausgeschlossene Interfaces (docker, vbox, etc.)
  → Resolved AUTO_IPV4 zu tatsächlicher IP
  → Gibt verfügbare Optionen zurück
```

**Interface-Typen:**

- `loopback` → `127.0.0.1`
- `ethernet` → Erste IPv4-Adresse von Ethernet-Interface
- `wifi` → Erste IPv4-Adresse von Wi-Fi-Interface
- `all` → `0.0.0.0` (alle Interfaces)

### 4. Web-App Auto-Open

Wenn Bridge erreichbar wird, öffnet sich automatisch die Web-App:

```typescript
if (status.reachable && !hasOpenedWebApp) {
  const webAppUrl = buildWebAppUrl(ip, interfaceType, port, outputs);
  shell.openExternal(webAppUrl);
}
```

**URL-Parameter:**

- `ip` - Resolved IP-Adresse
- `iptype` - Interface-Typ (ethernet, wifi, etc.)
- `port` - Bridge-Port
- `output1`, `output2` - Output-Konfiguration

## IPC-Handler

### Bridge-Kommandos

#### `bridgeStart`

```typescript
ipcMainHandle("bridgeStart", async (event, config: BridgeConfig) => {
  // Startet Bridge-Prozess
  // Startet Health Check Polling
  // Sendet initialen Status
  return { success: boolean, error: string, actualPort: number };
});
```

#### `bridgeStop`

```typescript
ipcMainHandle("bridgeStop", async () => {
  // Stoppt Health Check
  // Stoppt Bridge-Prozess
  // Sendet finalen Status
  return { success: boolean, error: string };
});
```

#### `bridgeGetStatus`

```typescript
ipcMainHandle("bridgeGetStatus", async () => {
  // Prüft ob Prozess läuft
  // Führt Health Check durch
  return BridgeStatus;
});
```

### Port-Checking

#### `checkPortAvailability`

```typescript
ipcMainHandle(
  "checkPortAvailability",
  async (event, port: number, host?: string) => {
    return { port: number, available: boolean };
  }
);
```

#### `checkPortsAvailability`

```typescript
ipcMainHandle('checkPortsAvailability', async (event, ports: number[], host?: string) => {
  // Prüft mehrere Ports parallel (in Batches von 10)
  return PortAvailability[]
})
```

### Netzwerk-Config

#### `getNetworkConfig`

```typescript
ipcMainHandle("getNetworkConfig", async () => {
  return loadNetworkConfig(); // NetworkConfigT
});
```

#### `detectNetworkInterfaces`

```typescript
ipcMainHandle("detectNetworkInterfaces", async () => {
  const config = loadNetworkConfig();
  return detectNetworkInterfaces(
    config.networkBinding.options,
    config.networkBinding.filters
  );
});
```

#### `getNetworkBindingOptions`

```typescript
ipcMainHandle('getNetworkBindingOptions', async () => {
  // Wie detectNetworkInterfaces, aber mit konsistentem Namen
  return NetworkBindingOptionT[]
})
```

## State-Management

Der Main Process verwaltet folgenden State:

```typescript
let healthCheckCleanup: (() => void) | null = null;
let bridgeOutputs: { output1: string; output2: string } | null = null;
let currentNetworkBindingId: string | null = null;
let hasOpenedWebApp = false;
```

**Cleanup:**

- Bei Window Close
- Bei App Quit (`before-quit` Event)

## Dateien

### `src/electron/main.ts`

Hauptdatei mit:

- App-Initialisierung
- IPC-Handler-Registrierung
- Bridge-Lifecycle-Management

### `src/electron/services/`

Service-Module:

- `bridge-process-manager.ts` - Bridge-Prozess-Verwaltung
- `bridge-health-check.ts` - Health Check Polling
- `network-interface-detector.ts` - Netzwerk-Erkennung
- `port-checker.ts` - Port-Verfügbarkeit

### `src/electron/preload.cts`

Preload-Script für IPC-Bridge

### `src/electron/pathResolver.ts`

Pfad-Auflösung für Dev/Prod

### `src/electron/util.ts`

Hilfsfunktionen (isDev, IPC-Wrapper)

## Fehlerbehandlung

### Bridge Start Fehler

- Port belegt → Automatisches Port-Finding
- IP nicht verfügbar → Fehler-Message
- Prozess startet nicht → Stderr wird analysiert

### Health Check Fehler

- Timeout nach 3 Sekunden
- Nicht-JSON Response → Port belegt von anderem Service
- Network Error → `reachable: false`

## Logging

Alle Logs sind mit Präfixen versehen:

- `[Bridge]` - Bridge-Prozess Output
- `[BridgeManager]` - Process Manager
- `[HealthCheck]` - Health Check
- `[NetworkConfig]` - Config Loading
- `[PortChecker]` - Port Checks
- `[WebApp]` - Web-App URL Building

## Weitere Dokumentation

- [Services](./SERVICES.md) - Detaillierte Service-Dokumentation
- [IPC Communication](./IPC_COMMUNICATION.md) - IPC-Protokoll Details
- [Config Management](./CONFIG_MANAGEMENT.md) - Config-System
