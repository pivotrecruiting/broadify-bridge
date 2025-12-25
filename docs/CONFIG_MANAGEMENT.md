# Config Management Dokumentation

## Übersicht

Das Config-Management-System verwaltet Netzwerk-Konfigurationen für die Desktop App. Es verwendet ein Template-System mit User-Config-Persistierung.

## Config-Hierarchie

```
1. User Data Config (app.getPath('userData')/network-config.json)
   └── Persistierte User-Einstellungen

2. Template Config (config/network-config.json)
   └── Projekt-Defaults, wird beim ersten Start kopiert

3. Hardcoded Default (DEFAULT_NETWORK_CONFIG in main.ts)
   └── Fallback wenn Template nicht gefunden wird
```

## Config-Loading: `loadNetworkConfig()`

### Priorität

```typescript
function loadNetworkConfig(): NetworkConfigT {
  // 1. Try User Data Config
  if (fs.existsSync(userDataConfigPath)) {
    return loadFromUserData();
  }

  // 2. Try Template Config (copy to User Data)
  if (fs.existsSync(templateConfigPath)) {
    copyTemplateToUserData();
    return loadFromTemplate();
  }

  // 3. Fallback to Hardcoded Default
  return DEFAULT_NETWORK_CONFIG;
}
```

### User Data Path

**macOS:**

```
~/Library/Application Support/electron-vite-template/network-config.json
```

**Windows:**

```
%APPDATA%/electron-vite-template/network-config.json
```

**Linux:**

```
~/.config/electron-vite-template/network-config.json
```

## Config-Struktur: `NetworkConfigT`

### Network Binding

```typescript
networkBinding: {
  default: {
    id: "localhost",
    label: "Localhost (Secure)",
    bindAddress: "127.0.0.1",
    recommended: true,
    advanced: false,
    description: "..."
  },
  options: [
    {
      id: "localhost",
      label: "Localhost (Secure)",
      bindAddress: "127.0.0.1",
      interface: "loopback",
      recommended: true,
      advanced: false,
      portConfig?: {
        customOnly: true,
        defaultPort: 8787
      }
    },
    // ... weitere Optionen
  ],
  filters: {
    excludeInterfaces: ["docker", "vbox", "vmnet", ...],
    excludeIpRanges: ["169.254.0.0/16"],
    ipv6: false
  }
}
```

### Port Config

```typescript
port: {
  default: 8787,
  autoFallback: [8788, 8789, 8790],
  allowCustom: true,
  customAdvancedOnly: true
}
```

### Security Config

```typescript
security: {
  lanMode: {
    enabled: false,
    requireAuth: false,
    readOnlyWithoutAuth: true
  }
}
```

## Interface-Typen

### `loopback`

- **bindAddress:** `127.0.0.1`
- **Zweck:** Nur lokal zugänglich
- **Sicherheit:** Höchste Sicherheit

### `ethernet`

- **bindAddress:** `AUTO_IPV4` (wird zu tatsächlicher IP aufgelöst)
- **Zweck:** Ethernet-Interface
- **Erkennung:** Interface-Namen mit "eth", "en", "ethernet", "lan"

### `wifi`

- **bindAddress:** `AUTO_IPV4` (wird zu tatsächlicher IP aufgelöst)
- **Zweck:** Wi-Fi-Interface
- **Erkennung:** Interface-Namen mit "wifi", "wlan", "wi-fi", "wireless"

### `all`

- **bindAddress:** `0.0.0.0`
- **Zweck:** Alle Interfaces
- **Sicherheit:** ⚠️ Exponiert Bridge auf gesamtes Netzwerk

## Interface-Filter

### Excluded Interfaces

Standardmäßig ausgeschlossen:

- `docker` - Docker-Interfaces
- `vbox` - VirtualBox-Interfaces
- `vmnet` - VMware-Interfaces
- `utun` - macOS Tunnel-Interfaces
- `wg` - WireGuard-Interfaces
- `tailscale` - Tailscale-Interfaces

### Excluded IP Ranges

Standardmäßig ausgeschlossen:

- `169.254.0.0/16` - Link-Local (APIPA)

### IPv6

Standardmäßig deaktiviert (`ipv6: false`), nur IPv4 wird verwendet.

## Port-Konfiguration

### Interface-spezifische Port-Config

Jede Interface-Option kann eine `portConfig` haben:

```typescript
portConfig: {
  customOnly: true,      // Nur Custom Port erlaubt
  defaultPort: 8787       // Default wenn customOnly
}
```

**Verhalten:**

- `customOnly: true` → User muss Port eingeben (keine Presets)
- `customOnly: false` → Preset-Ports verfügbar

### Global Port Config

```typescript
port: {
  default: 8787,                    // Standard-Port
  autoFallback: [8788, 8789, 8790], // Fallback-Ports wenn belegt
  allowCustom: true,                 // Custom Ports erlaubt
  customAdvancedOnly: true          // Custom nur im Advanced-Mode
}
```

## Config-Erkennung

### `detectNetworkInterfaces()`

Diese Funktion:

1. Liest `os.networkInterfaces()`
2. Filtert ausgeschlossene Interfaces
3. Resolved `AUTO_IPV4` zu tatsächlichen IPs
4. Gibt verfügbare Optionen zurück

**Beispiel:**

```typescript
const options = detectNetworkInterfaces(
  config.networkBinding.options,
  config.networkBinding.filters
);
// Returns: [
//   { id: "localhost", bindAddress: "127.0.0.1", ... },
//   { id: "ethernet", bindAddress: "192.168.1.100", ... },
//   { id: "wifi", bindAddress: "192.168.1.101", ... }
// ]
```

### `resolveBindAddress()`

Resolved spezielle Bind-Addressen:

- `AUTO_IPV4` → Tatsächliche IP des Interface-Typs
- `0.0.0.0` → Erste verfügbare externe IPv4
- `127.0.0.1` → Bleibt `127.0.0.1`

## Config-Persistierung

### Erste Ausführung

1. Template Config wird geladen (`config/network-config.json`)
2. Wird in User Data kopiert
3. Ab dann wird User Data Config verwendet

### User Config Updates

**Aktuell:** User Config wird nicht automatisch aktualisiert.

**Zukünftig:** Config-Migration-System könnte hinzugefügt werden:

- Version-Feld in Config
- Migration-Scripts für Breaking Changes

## Config-Validierung

**Aktuell:** TypeScript-Type-Checking

**Zukünftig:** Runtime-Validierung könnte hinzugefügt werden:

- JSON Schema Validation
- Config-Sanitization

## Beispiel-Config

Siehe `config/network-config.json` für vollständiges Beispiel.

## Best Practices

### 1. Template Config

- Immer im Projekt-Commit
- Dokumentiert alle verfügbaren Optionen
- Enthält Defaults für alle Felder

### 2. User Config

- Wird automatisch erstellt beim ersten Start
- Kann manuell bearbeitet werden
- Sollte nicht ins Git committed werden

### 3. Hardcoded Defaults

- Nur als letzter Fallback
- Sollte mit Template Config übereinstimmen
- Minimal gehalten

## Troubleshooting

### Config wird nicht geladen

1. Prüfe User Data Path: `app.getPath('userData')`
2. Prüfe ob Template existiert: `config/network-config.json`
3. Prüfe Logs: `[NetworkConfig]` Präfix

### Interface wird nicht erkannt

1. Prüfe Interface-Namen: `os.networkInterfaces()`
2. Prüfe Filter: `excludeInterfaces` in Config
3. Prüfe IP-Ranges: `excludeIpRanges` in Config

### Port-Config funktioniert nicht

1. Prüfe `portConfig` in Interface-Option
2. Prüfe `port.default` in Global Config
3. Prüfe `customAdvancedOnly` Flag

## Weitere Dokumentation

- [Main Process](./MAIN_PROCESS.md) - Config-Loading Implementation
- [Services](./SERVICES.md) - Network Interface Detection
- [Architecture](./ARCHITECTURE.md) - Gesamtarchitektur
