# Services Dokumentation

## Übersicht

Die Services (`src/electron/services/`) sind wiederverwendbare Module für spezifische Funktionalitäten im Main Process. Sie kapseln komplexe Logik und bieten klare APIs.

## Service-Module

### 1. Bridge Process Manager

**Datei:** `bridge-process-manager.ts`

**Zweck:** Verwaltet den Bridge-Prozess (Start, Stop, Monitoring)

**Klasse:** `BridgeProcessManager`

**API:**

```typescript
class BridgeProcessManager {
  async start(
    config: BridgeConfig,
    autoFindPort: boolean = true
  ): Promise<{ success: boolean; error?: string; actualPort?: number }>;

  async stop(): Promise<{ success: boolean; error?: string }>;

  isRunning(): boolean;

  getConfig(): BridgeConfig | null;
}
```

**Features:**

- Port-Verfügbarkeit-Prüfung vor Start
- Automatisches Port-Finding wenn Port belegt
- Process stdout/stderr Forwarding
- Graceful Shutdown (SIGTERM → SIGKILL nach 5s)
- Process-Status-Tracking

**Verwendung:**

```typescript
import { bridgeProcessManager } from "./services/bridge-process-manager.js";

const result = await bridgeProcessManager.start(
  {
    host: "127.0.0.1",
    port: 8787,
  },
  true
); // autoFindPort = true
```

**Singleton:** `bridgeProcessManager` (exported instance)

### 2. Bridge Health Check

**Datei:** `bridge-health-check.ts`

**Zweck:** Überwacht Bridge-Gesundheit via HTTP-Status-Endpoint

**Funktionen:**

```typescript
async function checkBridgeHealth(
  config: BridgeConfig | null
): Promise<BridgeStatus>;

function startHealthCheckPolling(
  config: BridgeConfig | null,
  onStatusUpdate: (status: BridgeStatus) => void,
  isProcessRunning?: () => boolean
): () => void; // Cleanup function
```

**Features:**

- HTTP GET `/status` Request
- 3 Sekunden Timeout
- JSON Response Validation
- HTML Response Detection (Port belegt)
- Polling alle 2 Sekunden
- Cleanup-Funktion zum Stoppen

**Health Check Flow:**

```
startHealthCheckPolling()
  → Initial Check
  → setInterval(poll, 2000ms)
  → onStatusUpdate(status)
  → Return cleanup function
```

**Verwendung:**

```typescript
const cleanup = startHealthCheckPolling(
  config,
  (status) => {
    ipcWebContentsSend("bridgeStatus", webContents, status);
  },
  () => bridgeProcessManager.isRunning()
);

// Later: cleanup();
```

**Status-Felder:**

- `running` - Prozess läuft (aus `isProcessRunning()`)
- `reachable` - HTTP-Status erfolgreich
- `version` - Bridge-Version
- `uptime` - Sekunden seit Start
- `mode` - "lan" oder "local"
- `port` - Gebundener Port
- `host` - Gebundene IP
- `error` - Fehler-Message (falls vorhanden)

### 3. Network Interface Detector

**Datei:** `network-interface-detector.ts`

**Zweck:** Erkennt verfügbare Netzwerk-Interfaces und resolved IP-Adressen

**Funktionen:**

```typescript
function detectNetworkInterfaces(
  configOptions: Array<NetworkBindingOptionConfig>,
  filters: InterfaceFilterConfig
): NetworkBindingOption[];

function resolveBindAddress(
  bindAddress: string,
  interfaceType: string,
  filters?: InterfaceFilterConfig
): string;
```

**Features:**

- Liest `os.networkInterfaces()`
- Filtert ausgeschlossene Interfaces
- Filtert ausgeschlossene IP-Ranges
- Resolved `AUTO_IPV4` zu tatsächlichen IPs
- Unterstützt IPv4/IPv6-Filter
- Interface-Typ-Erkennung (ethernet, wifi, loopback, all)

**Interface-Erkennung:**

**Ethernet:**

- Namen enthalten: "eth", "en", "ethernet", "lan"

**Wi-Fi:**

- Namen enthalten: "wifi", "wlan", "wi-fi", "wireless"

**Loopback:**

- Immer `127.0.0.1`

**All:**

- Immer `0.0.0.0` (wird zu erster externer IP resolved)

**Verwendung:**

```typescript
const config = loadNetworkConfig();
const options = detectNetworkInterfaces(
  config.networkBinding.options,
  config.networkBinding.filters
);
// Returns: [{ id: "localhost", bindAddress: "127.0.0.1", ... }, ...]
```

**IP-Resolution:**

```typescript
const ip = resolveBindAddress("AUTO_IPV4", "ethernet", filters);
// Returns: "192.168.1.100" (oder erste verfügbare Ethernet-IP)
```

### 4. Port Checker

**Datei:** `port-checker.ts`

**Zweck:** Prüft Port-Verfügbarkeit

**Funktionen:**

```typescript
async function isPortAvailable(
  port: number,
  host: string = "0.0.0.0"
): Promise<boolean>;

async function findAvailablePort(
  startPort: number,
  maxPort?: number,
  host: string = "0.0.0.0"
): Promise<number | null>;

async function checkPortsAvailability(
  ports: number[],
  host: string = "0.0.0.0"
): Promise<Map<number, boolean>>;
```

**Features:**

- TCP Socket-Binding-Test
- 2 Sekunden Timeout pro Port
- Parallel-Checking (Batches von 10)
- Unterstützt verschiedene Hosts (`0.0.0.0`, `127.0.0.1`, etc.)

**Verwendung:**

**Einzelner Port:**

```typescript
const available = await isPortAvailable(8787, "127.0.0.1");
// Returns: true | false
```

**Port-Finding:**

```typescript
const port = await findAvailablePort(8787, 8790, "127.0.0.1");
// Returns: 8787 | 8788 | 8789 | 8790 | null
```

**Mehrere Ports:**

```typescript
const results = await checkPortsAvailability([8787, 8788, 8789], "127.0.0.1");
// Returns: Map<8787, true>, Map<8788, false>, Map<8789, true>
```

**Implementation:**

- Erstellt temporären TCP-Server
- Versucht auf Port zu binden
- `EADDRINUSE` → Port belegt
- `listening` Event → Port verfügbar
- Cleanup nach Check

## Service-Interaktionen

### Bridge Start Flow

```
bridgeStart IPC Handler
  │
  ├─→ bridgeProcessManager.start()
  │     │
  │     ├─→ port-checker.isPortAvailable()
  │     │     └─→ Falls belegt: findAvailablePort()
  │     │
  │     └─→ spawn(bridgeProcess)
  │
  └─→ startHealthCheckPolling()
        │
        └─→ checkBridgeHealth()
              └─→ HTTP GET /status
```

### Network Config Flow

```
getNetworkBindingOptions IPC Handler
  │
  ├─→ loadNetworkConfig()
  │     └─→ Lädt Config (User Data → Template → Default)
  │
  └─→ detectNetworkInterfaces()
        │
        ├─→ os.networkInterfaces()
        ├─→ Filter Interfaces
        └─→ Resolve AUTO_IPV4
```

## Error Handling

### Bridge Process Manager

- Port belegt → Automatisches Port-Finding
- Process startet nicht → Stderr-Analyse
- Process crashed → Exit-Code-Tracking

### Health Check

- Timeout → `reachable: false`
- Nicht-JSON Response → Port belegt von anderem Service
- Network Error → `error` Field gesetzt

### Network Interface Detector

- Kein Interface gefunden → Option wird übersprungen
- IP-Resolution fehlgeschlagen → Fallback zu `127.0.0.1`

### Port Checker

- Timeout → `false` (Port als belegt behandelt)
- Socket Error → `false`
- Cleanup-Fehler → Ignoriert

## Logging

Alle Services loggen mit Präfixen:

- `[BridgeManager]` - Process Manager
- `[HealthCheck]` - Health Check
- `[NetworkConfig]` - Interface Detection
- `[PortChecker]` - Port Checks

## Testing

**Aktuell:** Keine Unit-Tests

**Zukünftig:** Services sollten getestet werden:

- Mock `os.networkInterfaces()`
- Mock `spawn()` für Process Manager
- Mock `fetch()` für Health Check
- Mock TCP-Server für Port Checker

## Weitere Dokumentation

- [Main Process](./MAIN_PROCESS.md) - Service-Verwendung
- [Config Management](./CONFIG_MANAGEMENT.md) - Network Config
- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
