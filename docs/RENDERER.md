# Renderer (UI) Dokumentation

## Übersicht

Der Renderer (`src/ui/`) ist die React-basierte Benutzeroberfläche. Er kommuniziert ausschließlich über IPC mit dem Main Process und hat keinen direkten Node.js-Zugriff.

## Architektur

```
App.tsx (Root Component)
    │
    ├── Header
    ├── NetworkSection
    │   ├── NetworkInterfaceSelector
    │   └── PortSelector
    ├── EngineSection
    ├── OutputsSection
    ├── StatusIndicator
    └── BridgeControlButton
```

## Hauptkomponente: App.tsx

### State-Management

Die App verwendet mehrere Custom Hooks für State:

```typescript
const {
  networkConfig,
  networkBindingOptions,
  networkBindingId,
  setNetworkBindingId,
  networkPort,
  setNetworkPort,
  customPort,
  setCustomPort,
  showAdvanced,
  setShowAdvanced,
} = useNetworkConfig();

const bridgeStatus = useBridgeStatus();

const { portAvailability, checkingPorts } = usePortAvailability({...});

const { handleBindingChange, getCurrentBindAddress, getCurrentPortConfig } =
  useNetworkBinding({...});
```

### Bridge Start/Stop

```typescript
const handleStartBridge = async () => {
  const portToUse = calculatePortToUse(...);
  const bindAddress = getCurrentBindAddress();

  await window.electron.bridgeStart({
    host: bindAddress,
    port: portToUse,
    outputs: { output1, output2 },
    networkBindingId,
  });
};
```

## Custom Hooks

### `use-network-config.ts`

**Zweck:** Lädt und verwaltet Netzwerk-Konfiguration

**Funktionen:**

- Lädt `networkConfig` via IPC
- Lädt `networkBindingOptions` (mit erkannten Interfaces)
- Setzt Default-Werte basierend auf Config
- Verwaltet `networkBindingId`, `networkPort`, `customPort`

**API:**

```typescript
const {
  networkConfig, // NetworkConfigT | null
  networkBindingOptions, // NetworkBindingOptionT[]
  networkBindingId, // string
  setNetworkBindingId, // (id: string) => void
  networkPort, // string
  setNetworkPort, // (port: string) => void
  customPort, // string
  setCustomPort, // (port: string) => void
  showAdvanced, // boolean
  setShowAdvanced, // (show: boolean) => void
} = useNetworkConfig();
```

### `use-bridge-status.ts`

**Zweck:** Überwacht Bridge-Status via IPC Events

**Funktionen:**

- Abonniert `bridgeStatus` Events
- Aktualisiert State bei Status-Änderungen
- Cleanup bei Unmount

**API:**

```typescript
const bridgeStatus: BridgeStatus = useBridgeStatus();
// { running: boolean, reachable: boolean, ... }
```

### `use-port-availability.ts`

**Zweck:** Prüft Port-Verfügbarkeit

**Funktionen:**

- Prüft Ports basierend auf aktueller Konfiguration
- Batch-Checks für mehrere Ports
- Zeigt Loading-State während Prüfung

**API:**

```typescript
const {
  portAvailability, // Map<number, boolean>
  checkingPorts, // boolean
} = usePortAvailability({
  networkBindingId,
  networkPort,
  customPort,
  showAdvanced,
  bridgeStatus,
  networkConfig,
  networkBindingOptions,
});
```

### `use-network-binding.ts`

**Zweck:** Verwaltet Netzwerk-Binding-Logik

**Funktionen:**

- Handhabt Binding-Wechsel
- Resolved Bind-Addressen
- Gibt Port-Config zurück

**API:**

```typescript
const {
  handleBindingChange,      // (id: string) => void
  getCurrentBindAddress,     // () => string
  getCurrentPortConfig,      // () => InterfacePortConfigT | undefined
} = useNetworkBinding({...});
```

## UI-Komponenten

### `NetworkSection.tsx`

**Zweck:** Netzwerk-Konfiguration

**Komponenten:**

- `NetworkInterfaceSelector` - Interface-Auswahl
- `PortSelector` - Port-Auswahl

**Features:**

- Zeigt verfügbare Interfaces
- Port-Verfügbarkeit-Anzeige
- Advanced-Mode Toggle

### `NetworkInterfaceSelector.tsx`

**Props:**

```typescript
{
  options: NetworkBindingOptionT[];
  value: string;
  onChange: (id: string) => void;
}
```

**Features:**

- Dropdown mit Interface-Optionen
- Zeigt Warnungen für unsichere Optionen
- Markiert empfohlene Optionen

### `PortSelector.tsx`

**Props:**

```typescript
{
  networkPort: string;
  customPort: string;
  showAdvanced: boolean;
  portAvailability: Map<number, boolean>;
  checkingPorts: boolean;
  onPortChange: (port: string) => void;
  onCustomPortChange: (port: string) => void;
  onAdvancedToggle: (show: boolean) => void;
  portConfig?: InterfacePortConfigT;
}
```

**Features:**

- Preset-Port-Auswahl
- Custom Port Input (wenn Advanced)
- Port-Verfügbarkeit-Anzeige
- Validierung

### `StatusIndicator.tsx`

**Zweck:** Zeigt Bridge-Status

**States:**

- `running: false` → "Stopped" (grau)
- `running: true, reachable: false` → "Starting..." (gelb)
- `running: true, reachable: true` → "Running" (grün)

### `BridgeControlButton.tsx`

**Zweck:** Start/Stop Button

**Props:**

```typescript
{
  isRunning: boolean;
  isReachable: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
}
```

**Features:**

- Text ändert sich basierend auf Status
- Disabled während Start/Stop
- Loading-State

### `EngineSection.tsx`

**Zweck:** Engine-Auswahl (ATEM, etc.)

**Features:**

- Dropdown mit Engine-Optionen
- Port-Konfiguration basierend auf Engine

### `OutputsSection.tsx`

**Zweck:** Output-Konfiguration

**Features:**

- Output 1 & 2 Auswahl
- Dropdowns mit verfügbaren Outputs

## Utilities

### `network-utils.ts`

**Funktionen:**

- `getDefaultPortForBinding()` - Gibt Default-Port für Binding zurück

### `port-utils.ts`

**Funktionen:**

- `validatePort()` - Validiert Port-String
- `parsePort()` - Parst Port zu Number
- `shouldUseCustomPort()` - Entscheidet ob Custom Port verwendet werden soll
- `calculatePortToUse()` - Berechnet finalen Port

## Styling

### Tailwind CSS

- Utility-First CSS Framework
- Responsive Design
- Dark Mode Support (optional)

### Custom Styles

- `App.css` - Globale Styles
- OpenSans Font Family
- Glass-Morphism Effects (`glass-utils.tsx`)

## IPC-Kommunikation

Alle IPC-Calls gehen über `window.electron.*`:

```typescript
// Commands
await window.electron.bridgeStart(config);
await window.electron.bridgeStop();
await window.electron.bridgeGetStatus();

// Subscriptions
const unsubscribe = window.electron.subscribeBridgeStatus((status) => {
  // Handle status update
});

// Config
const config = await window.electron.getNetworkConfig();
const options = await window.electron.getNetworkBindingOptions();

// Port Checks
const result = await window.electron.checkPortAvailability(port, host);
```

## Type Safety

Alle IPC-Types sind in `types.d.ts` definiert:

```typescript
declare global {
  interface Window {
    electron: {
      bridgeStart: (config: BridgeConfig) => Promise<{...}>;
      bridgeStop: () => Promise<{...}>;
      // ...
    };
  }
}
```

## Weitere Dokumentation

- [IPC Communication](./IPC_COMMUNICATION.md) - IPC-Protokoll Details
- [Config Management](./CONFIG_MANAGEMENT.md) - Config-System
- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
