# Dokumentation

Diese Dokumentation beschreibt die Architektur, Komponenten und Zusammenhänge der Broadify Bridge v2 Anwendung.

## Übersicht

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Gesamtarchitektur der Anwendung
  - Sicherheitszonen (Main Process, Preload, Renderer, Bridge)
  - Datenfluss-Diagramme
  - Build-Prozess

- **[MAIN_PROCESS.md](./MAIN_PROCESS.md)** - Main Process Dokumentation
  - Bridge-Prozess-Management
  - Health Check Polling
  - Netzwerk-Konfiguration
  - IPC-Handler

- **[RENDERER.md](./RENDERER.md)** - Renderer/UI Dokumentation
  - React-Komponenten
  - Custom Hooks
  - State-Management
  - IPC-Kommunikation

- **[BRIDGE.md](./BRIDGE.md)** - Bridge-Server Dokumentation
  - HTTP-Server (Fastify)
  - Status-Endpoint
  - Config-Parsing
  - Logging

- **[IPC_COMMUNICATION.md](./IPC_COMMUNICATION.md)** - IPC-Protokoll
  - IPC-Channels
  - Request/Response-Patterns
  - Event-Subscriptions
  - Type Safety

- **[CONFIG_MANAGEMENT.md](./CONFIG_MANAGEMENT.md)** - Konfigurationssystem
  - Config-Hierarchie
  - Network Binding Options
  - Interface-Erkennung
  - Port-Konfiguration

- **[SERVICES.md](./SERVICES.md)** - Service-Module
  - Bridge Process Manager
  - Health Check Service
  - Network Interface Detector
  - Port Checker

## Schnellstart

### Für Entwickler

1. **Architektur verstehen:** Starte mit [ARCHITECTURE.md](./ARCHITECTURE.md)
2. **Main Process:** Lies [MAIN_PROCESS.md](./MAIN_PROCESS.md) für Backend-Logik
3. **UI entwickeln:** Siehe [RENDERER.md](./RENDERER.md) für Frontend-Komponenten
4. **IPC verwenden:** Konsultiere [IPC_COMMUNICATION.md](./IPC_COMMUNICATION.md) für Kommunikation

### Für Maintainer

1. **Services erweitern:** Siehe [SERVICES.md](./SERVICES.md)
2. **Config anpassen:** Siehe [CONFIG_MANAGEMENT.md](./CONFIG_MANAGEMENT.md)
3. **Bridge erweitern:** Siehe [BRIDGE.md](./BRIDGE.md)

## Dokumentations-Struktur

```
docs/
├── README.md              # Diese Datei (Übersicht)
├── ARCHITECTURE.md        # Gesamtarchitektur
├── MAIN_PROCESS.md         # Main Process Details
├── RENDERER.md            # UI-Komponenten
├── BRIDGE.md              # Bridge-Server
├── IPC_COMMUNICATION.md    # IPC-Protokoll
├── CONFIG_MANAGEMENT.md    # Config-System
└── SERVICES.md            # Service-Module
```

## Aktualisierung

Diese Dokumentation sollte aktualisiert werden, wenn:
- Neue Features hinzugefügt werden
- Architektur-Änderungen vorgenommen werden
- APIs geändert werden
- Neue Services hinzugefügt werden

## Fragen?

Bei Fragen zur Architektur oder Implementierung, konsultiere die entsprechende Dokumentationsdatei oder den Code selbst.

