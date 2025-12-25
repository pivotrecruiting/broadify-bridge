# IPC Kommunikation Dokumentation

## Übersicht

Die IPC (Inter-Process Communication) ermöglicht die sichere Kommunikation zwischen Renderer (React UI) und Main Process (Electron). Die Kommunikation erfolgt über Electron's IPC-System mit Type-Safety durch TypeScript.

## Architektur

```
Renderer (React)
    │
    │ window.electron.*
    ▼
Preload (contextBridge)
    │
    │ ipcRenderer.invoke/on
    ▼
Main Process (ipcMain)
    │
    │ Handler Logic
    ▼
Services / Bridge Process
```

## Preload Script: `src/electron/preload.cts`

### Exposed APIs

Das Preload-Script exponiert folgende APIs via `contextBridge`:

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

  // Port Checking
  checkPortAvailability: (port: number, host?: string) => Promise<PortAvailability>,
  checkPortsAvailability: (ports: number[], host?: string) => Promise<PortAvailability[]>,

  // Network Config
  getNetworkConfig: () => Promise<NetworkConfigT>,
  detectNetworkInterfaces: () => Promise<NetworkBindingOptionT[]>,
  getNetworkBindingOptions: () => Promise<NetworkBindingOptionT[]>,
}
```

### IPC Wrapper Functions

```typescript
function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
  ...args: any[]
): Promise<EventPayloadMapping[Key]>;

function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void
): UnsubscribeFunction;
```

## IPC Channels

### Commands (Request/Response)

#### `getStaticData`

**Renderer → Main**

```typescript
const data = await window.electron.getStaticData();
// Returns: StaticData
```

**Main Handler:**

```typescript
ipcMainHandle("getStaticData", () => {
  return getStaticData(); // { totalStorage, cpuModel, totalMemoryGB }
});
```

#### `bridgeStart`

**Renderer → Main**

```typescript
const result = await window.electron.bridgeStart({
  host: "127.0.0.1",
  port: 8787,
  outputs: { output1: "...", output2: "..." },
  networkBindingId: "localhost",
});
// Returns: { success: boolean, error?: string, actualPort?: number }
```

**Main Handler:**

```typescript
ipcMainHandle("bridgeStart", async (event, config: BridgeConfig) => {
  const result = await bridgeProcessManager.start(config, true);
  // Start health check polling
  return result;
});
```

#### `bridgeStop`

**Renderer → Main**

```typescript
const result = await window.electron.bridgeStop();
// Returns: { success: boolean, error?: string }
```

**Main Handler:**

```typescript
ipcMainHandle("bridgeStop", async () => {
  // Stop health check
  const result = await bridgeProcessManager.stop();
  // Send final status
  return result;
});
```

#### `bridgeGetStatus`

**Renderer → Main**

```typescript
const status = await window.electron.bridgeGetStatus();
// Returns: BridgeStatus
```

**Main Handler:**

```typescript
ipcMainHandle("bridgeGetStatus", async () => {
  const isRunning = bridgeProcessManager.isRunning();
  const healthStatus = await checkBridgeHealth(config);
  return { ...healthStatus, running: isRunning };
});
```

#### `checkPortAvailability`

**Renderer → Main**

```typescript
const result = await window.electron.checkPortAvailability(8787, "127.0.0.1");
// Returns: { port: 8787, available: boolean }
```

**Main Handler:**

```typescript
ipcMainHandle(
  "checkPortAvailability",
  async (event, port: number, host?: string) => {
    const available = await isPortAvailable(port, host || "0.0.0.0");
    return { port, available };
  }
);
```

#### `checkPortsAvailability`

**Renderer → Main**

```typescript
const results = await window.electron.checkPortsAvailability([
  8787, 8788, 8789,
]);
// Returns: [{ port: 8787, available: true }, ...]
```

**Main Handler:**

```typescript
ipcMainHandle(
  "checkPortsAvailability",
  async (event, ports: number[], host?: string) => {
    const results = await checkPortsAvailability(ports, host || "0.0.0.0");
    return Array.from(results.entries()).map(([port, available]) => ({
      port,
      available,
    }));
  }
);
```

#### `getNetworkConfig`

**Renderer → Main**

```typescript
const config = await window.electron.getNetworkConfig();
// Returns: NetworkConfigT
```

**Main Handler:**

```typescript
ipcMainHandle("getNetworkConfig", async () => {
  return loadNetworkConfig();
});
```

#### `detectNetworkInterfaces`

**Renderer → Main**

```typescript
const options = await window.electron.detectNetworkInterfaces();
// Returns: NetworkBindingOptionT[]
```

**Main Handler:**

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

**Renderer → Main**

```typescript
const options = await window.electron.getNetworkBindingOptions();
// Returns: NetworkBindingOptionT[]
```

**Main Handler:**

```typescript
ipcMainHandle("getNetworkBindingOptions", async () => {
  const config = loadNetworkConfig();
  return detectNetworkInterfaces(
    config.networkBinding.options,
    config.networkBinding.filters
  );
});
```

### Events (Push from Main)

#### `statistics`

**Main → Renderer**

```typescript
const unsubscribe = window.electron.subscribeStatistics((stats) => {
  // Handle statistics update
  // { cpuUsage, ramUsage, storageData }
});
```

**Main Sender:**

```typescript
ipcWebContentsSend("statistics", mainWindow.webContents, statistics);
```

#### `bridgeStatus`

**Main → Renderer**

```typescript
const unsubscribe = window.electron.subscribeBridgeStatus((status) => {
  // Handle bridge status update
  // { running, reachable, version, uptime, ... }
});
```

**Main Sender:**

```typescript
ipcWebContentsSend("bridgeStatus", mainWindow.webContents, status);
// Called from health check polling
```

## Type Definitions

Alle IPC-Types sind in `types.d.ts` definiert:

```typescript
export type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  bridgeStart: { success: boolean; error?: string; actualPort?: number };
  bridgeStop: { success: boolean; error?: string };
  bridgeGetStatus: BridgeStatus;
  bridgeStatus: BridgeStatus;
  checkPortAvailability: PortAvailability;
  checkPortsAvailability: PortAvailability[];
  getNetworkConfig: NetworkConfigT;
  detectNetworkInterfaces: NetworkBindingOptionT[];
  getNetworkBindingOptions: NetworkBindingOptionT[];
};
```

## Sicherheit

### Context Isolation

- `contextIsolation: true` - Renderer hat keinen direkten Node-Zugriff
- `nodeIntegration: false` - Keine Node-APIs im Renderer
- `sandbox: true` (wenn kompatibel) - Zusätzliche Sandbox

### IPC Security

- Nur whitelisted APIs werden exponiert
- Alle IPC-Inputs sollten validiert werden (aktuell TypeScript-only)
- Keine arbitrary command execution aus Renderer

## Best Practices

### 1. Type Safety

Verwende immer die definierten Types:

```typescript
// ✅ Good
const status: BridgeStatus = await window.electron.bridgeGetStatus();

// ❌ Bad
const status: any = await window.electron.bridgeGetStatus();
```

### 2. Error Handling

Behandle Fehler immer:

```typescript
try {
  const result = await window.electron.bridgeStart(config);
  if (!result.success) {
    console.error("Bridge start failed:", result.error);
  }
} catch (error) {
  console.error("IPC error:", error);
}
```

### 3. Cleanup

Unsubscribe von Events:

```typescript
useEffect(() => {
  const unsubscribe = window.electron.subscribeBridgeStatus((status) => {
    setStatus(status);
  });

  return () => {
    unsubscribe(); // Cleanup
  };
}, []);
```

### 4. Async/Await

Verwende async/await statt Promises:

```typescript
// ✅ Good
const config = await window.electron.getNetworkConfig();

// ❌ Bad
window.electron.getNetworkConfig().then(config => { ... });
```

## Debugging

### IPC Logging

Main Process loggt alle IPC-Calls:

```typescript
console.log("[IPC] bridgeStart called with:", config);
```

### Renderer Logging

Renderer kann IPC-Calls loggen:

```typescript
console.log("Calling bridgeStart...");
const result = await window.electron.bridgeStart(config);
console.log("Result:", result);
```

## Weitere Dokumentation

- [Main Process](./MAIN_PROCESS.md) - IPC-Handler Details
- [Renderer](./RENDERER.md) - IPC-Verwendung im Renderer
- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
