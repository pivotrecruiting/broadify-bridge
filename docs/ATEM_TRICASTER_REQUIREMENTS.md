# ATEM/Tricaster Integration - Anforderungen

## Übersicht

Dieses Dokument beschreibt die Anforderungen und die optimale Vorgehensweise für die Integration von ATEM Switchern und Tricaster Systemen in die Broadify Bridge v2.

## Ziel

Die Bridge soll als Vermittler zwischen ATEM/Tricaster Switchern und Hardware-Output-Geräten (Decklink Cards, USB Capture) fungieren, um Video-Signale über HDMI/SDI/USB zu routen.

## Architektur-Ziel

```
┌─────────────────────────────────────────────────────────┐
│              Desktop App (Electron)                       │
│                                                           │
│  UI: Engine Config (ATEM IP/Port)                        │
│      Output Selection (Decklink/USB)                     │
│                                                           │
└──────────────────┬───────────────────────────────────────┘
                   │ IPC
                   ▼
┌─────────────────────────────────────────────────────────┐
│              Bridge Process                             │
│                                                           │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │ ATEM/Tricaster   │    │ Device Modules   │           │
│  │ Client           │    │                  │           │
│  │                  │    │ - Decklink       │           │
│  │ - Connect        │    │ - USB Capture    │           │
│  │ - Commands       │    │                  │           │
│  │ - Status Sync    │    │                  │           │
│  └────────┬─────────┘    └────────┬─────────┘           │
│           │                       │                      │
│           │ Network               │ Hardware             │
│           │ (TCP/HTTP)             │ (HDMI/SDI/USB)      │
│           ▼                       ▼                      │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │ ATEM Switcher    │    │ Decklink Card    │           │
│  │ (192.168.1.1)    │    │ USB Capture      │           │
│  └──────────────────┘    └──────────────────┘           │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## Aktueller Stand

### Vorhanden

- ✅ UI: Engine-Section mit ATEM IP/Port Auswahl
- ✅ Bridge: HTTP-Server (Fastify) läuft
- ✅ Outputs: Device-Erkennung vorbereitet (noch ohne echte Hardware)
- ✅ Network: Interface-Erkennung funktioniert

### Fehlt

- ❌ Engine-Konfiguration wird nicht an Bridge übergeben
- ❌ Keine ATEM/Tricaster SDK Integration
- ❌ Keine Device-Module für Hardware-Kommunikation
- ❌ Keine Protokoll-Handler (ATEM Protocol, Tricaster API)

## Implementierungs-Phasen

### Phase 1: Bridge erweitern (Grundlagen)

#### 1.1 Bridge Config erweitern

**Datei**: `types.d.ts`

```typescript
export type BridgeConfig = {
  host: string;
  port: number;
  outputs?: {
    output1: string;
    output2: string;
  };
  engine?: {
    // NEU
    type: "atem" | "tricaster";
    ip: string;
    port: number;
  };
  networkBindingId?: string;
};
```

#### 1.2 Engine Config an Bridge übergeben

**Änderungen**:

- `App.tsx`: `engineAtem` und `enginePort` an `bridgeStart()` übergeben
- `bridge-process-manager.ts`: Engine Config als CLI-Args oder Config-File an Bridge

#### 1.3 Bridge Config Schema erweitern

**Datei**: `apps/bridge/src/config.ts`

- Zod Schema um Engine Config erweitern
- CLI Arguments für Engine Config hinzufügen

**Zeitaufwand**: 1-2 Tage

---

### Phase 2: Device-Module Architektur

#### 2.1 Device Module System

**Struktur**:

```
apps/bridge/src/
  ├── modules/
  │   ├── device-module.ts (Base Interface)
  │   ├── decklink/
  │   │   ├── decklink-detector.ts
  │   │   └── decklink-device.ts
  │   ├── usb-capture/
  │   │   └── usb-capture-detector.ts
  │   └── index.ts
```

#### 2.2 Device Detection implementieren

**Decklink Cards**:

- Blackmagic Desktop Video SDK
- Platform-spezifisch:
  - macOS: AVFoundation
  - Windows: DirectShow
  - Linux: v4l2

**USB Capture**:

- Platform-spezifisch:
  - macOS: AVFoundation (AVCaptureDevice)
  - Windows: DirectShow (WDM)
  - Linux: v4l2 (Video4Linux2)

**Connection Types**:

- Basierend auf erkannten Hardware-Geräten
- SDI: Verfügbar wenn Decklink Card erkannt
- HDMI: Verfügbar wenn HDMI-fähiges Gerät erkannt
- USB: Verfügbar wenn USB Capture Gerät erkannt
- DisplayPort/Thunderbolt: Via System-APIs erkennen

**Zeitaufwand**: 5-7 Tage

---

### Phase 3: ATEM/Tricaster Integration

#### 3.1 Protokoll-Handler

**Struktur**:

```
apps/bridge/src/
  ├── protocols/
  │   ├── atem/
  │   │   ├── atem-client.ts
  │   │   ├── atem-protocol.ts
  │   │   └── atem-commands.ts
  │   └── tricaster/
  │       ├── tricaster-client.ts
  │       └── tricaster-api.ts
```

#### 3.2 ATEM Protocol

**Details**:

- **Protokoll**: Blackmagic ATEM Protocol (TCP/IP)
- **Port**: 9910 (Standard)
- **Format**: Binary Protocol (Big Endian)
- **Library**: `atem-connection` (npm) oder native Implementation

**Funktionen**:

- Verbindung zu ATEM Switcher
- Commands: Program/Preview, Transitions, Media Pool
- State Synchronization: ATEM sendet regelmäßig Status-Updates

**Zeitaufwand**: 3-5 Tage

#### 3.3 Tricaster API

**Details**:

- **Protokoll**: HTTP REST API
- **Port**: 8080 (Standard)
- **Format**: JSON Payloads
- **Authentication**: Basic Auth oder Token
- **Updates**: WebSocket oder Polling

**Funktionen**:

- Verbindung zu Tricaster System
- Commands: Switcher Control, Input Selection
- Status Updates: Real-time oder Polling

**Zeitaufwand**: 3-5 Tage

---

### Phase 4: Bridge → Hardware Kommunikation

#### 4.1 Output Routing

**Flow**:

```
Bridge Process
    │
    ├── ATEM/Tricaster Client (Network)
    │   │
    │   └── Commands: Program/Preview, Transitions
    │
    └── Device Module (Hardware)
        │
        ├── Decklink Card
        │   └── HDMI/SDI Output
        │
        └── USB Capture
            └── USB Output
```

#### 4.2 Bridge Routes erweitern

**Neue Endpoints**:

```typescript
// apps/bridge/src/routes/
GET / status; // Bereits vorhanden
GET / outputs; // Bereits vorhanden
POST / engine / connect; // NEU: Verbinde mit ATEM/Tricaster
POST / engine / command; // NEU: Sende Command (Program, Preview, etc.)
GET / engine / status; // NEU: Engine Status
```

**Zeitaufwand**: 3-5 Tage

---

## Technische Details

### ATEM Protocol Library

**Option 1: npm Package**

```bash
npm install atem-connection
```

**Option 2: Native Implementation**

- TCP Socket Verbindung
- Binary Protocol Parsing
- Command Structure: Header + Payload

### Blackmagic Desktop Video SDK

**Anforderungen**:

- Native Libraries erforderlich
- Platform-spezifische Binaries
- Device Enumeration API
- Format/Capability Detection

**Platform Support**:

- macOS: AVFoundation
- Windows: DirectShow
- Linux: v4l2

### USB Capture Detection

**Platform-spezifisch**:

- macOS: AVFoundation (AVCaptureDevice)
- Windows: DirectShow (WDM)
- Linux: v4l2 (Video4Linux2)

---

## Empfohlene Implementierungsreihenfolge

### Schritt 1: Bridge Config erweitern (1-2 Tage)

- ✅ Engine Config zu `BridgeConfig` hinzufügen
- ✅ Engine Config an Bridge übergeben
- ✅ Bridge Config Schema erweitern

### Schritt 2: ATEM Client implementieren (3-5 Tage)

- ✅ `atem-connection` Library integrieren
- ✅ ATEM Connection Handler in Bridge
- ✅ Basic Commands (Program/Preview)
- ✅ Status Synchronization

### Schritt 3: Device Detection (5-7 Tage)

- ✅ Decklink Detection implementieren
- ✅ USB Capture Detection implementieren
- ✅ Connection Types basierend auf Hardware

### Schritt 4: Output Routing (3-5 Tage)

- ✅ Bridge Routes für Engine Commands
- ✅ Device Module für Hardware Output
- ✅ Bridge → ATEM → Hardware Flow

### Schritt 5: Tricaster Support (3-5 Tage)

- ✅ Tricaster HTTP API Client
- ✅ Tricaster Commands implementieren
- ✅ Engine Type Detection (ATEM vs Tricaster)

**Gesamt-Zeitaufwand**: ~15-24 Tage

---

## Device-Erkennung Best Practices

### Output1 (Decklink Cards, USB Capture)

**Verhalten**:

- Alle Hardware-Geräte im System erkennen (auch ohne angeschlossenes Kabel)
- `available` Flag für Bereitschaftsstatus nutzen
- Beispiel:
  - Decklink Card installiert → Wird erkannt
  - `available: true` = Gerät bereit
  - `available: false` = Gerät erkannt, aber nicht bereit (z.B. kein Signal)

### Output2 (Connection Types)

**Verhalten**:

- Basierend auf erkannten Hardware-Geräten anzeigen
- Beispiel:
  - Decklink Card erkannt → SDI/HDMI Optionen anzeigen
  - USB Capture erkannt → USB Option anzeigen
  - Auch wenn kein Kabel angeschlossen ist

---

## Nächste Schritte

1. **Bridge Config erweitern**: Engine Config hinzufügen
2. **ATEM Library evaluieren**: `atem-connection` testen
3. **Device Detection starten**: Decklink Detection implementieren
4. **Prototyp**: Einfacher ATEM → Decklink Flow

---

## Referenzen

- [ATEM Protocol Documentation](https://www.blackmagicdesign.com/support)
- [Tricaster API Documentation](https://www.newtek.com/tricaster/)
- [Blackmagic Desktop Video SDK](https://www.blackmagicdesign.com/support)
- [atem-connection npm](https://www.npmjs.com/package/atem-connection)
