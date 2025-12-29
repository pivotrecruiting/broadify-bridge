# Web-App Relay Integration Guide

## Übersicht

Diese Dokumentation beschreibt, was in der Web-App implementiert werden muss, um mit dem Relay Server (Fly.io) und somit der Bridge zu kommunizieren.

---

## Architektur-Änderung

### Vorher (Tunnel-basiert)

```
Web-App → Cloudflare Tunnel → Bridge (direkt)
```

### Jetzt (Relay-basiert)

```
Web-App → Cloud API → Relay Server (Fly.io) → Bridge (outbound WS)
```

**Wichtig:** Die Web-App kommuniziert **nicht mehr direkt** mit der Bridge. Alle Commands laufen über den Relay Server.

---

## Was muss implementiert werden?

### 1. API Route: `/api/bridges/[bridgeId]/command`

**Pfad:** `app/api/bridges/[bridgeId]/command/route.ts` (Next.js App Router)

**Funktion:**

- Empfängt Commands von der Web-App
- Sendet Command an Relay Server
- Wartet auf Response
- Sendet Response zurück an Web-App

**Request:**

```typescript
POST /api/bridges/[bridgeId]/command
{
  "command": "get_status" | "engine_connect" | "engine_run_macro" | ...,
  "payload": { ... }
}
```

**Response:**

```typescript
{
  "success": boolean,
  "data"?: unknown,
  "error"?: string
}
```

**Implementation:**

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: { bridgeId: string } }
) {
  const { bridgeId } = params;
  const body = await request.json();
  const { command, payload } = body;

  // Validate session (später: Supabase Auth)
  // const session = await getSession(request);
  // if (!session) {
  //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // }

  try {
    // Send command to relay server
    // Note: Web-App uses HTTP, Bridge uses WebSocket (wss://)
    const relayUrl = process.env.RELAY_API_URL || "https://broadify-relay.fly.dev";
    const response = await fetch(`${relayUrl}/relay/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bridgeId,
        command,
        payload,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      return NextResponse.json(
        { success: false, error: error.message || "Relay error" },
        { status: response.status }
      );
    }

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
```

**Environment Variable:**

```env
# Optional: Standard ist https://broadify-relay.fly.dev
RELAY_API_URL=https://broadify-relay.fly.dev
```

**Wichtig:**

- **Web-App** verwendet `https://broadify-relay.fly.dev` (HTTP) für API-Calls
- **Bridge** verwendet `wss://broadify-relay.fly.dev` (WebSocket) für die Verbindung
- Beide zeigen auf denselben Relay Server, verwenden aber unterschiedliche Protokolle

---

### 2. Bridge Connection UI

#### Vorher (zu entfernen)

- ❌ IP-Adress-Eingabe
- ❌ Port-Eingabe
- ❌ Tunnel URL Anzeige
- ❌ "Connect via Tunnel" Button
- ❌ `useTunnel` Query Parameter Handling

#### Neu (zu implementieren)

- ✅ Bridge ID Eingabe
- ✅ "Connect" Button (testet Relay-Verbindung)
- ✅ Bridge Status Anzeige (Connected/Disconnected)
- ✅ Bridge ID Anzeige (wenn verbunden)

**Beispiel Component:**

```typescript
// components/BridgeConnection.tsx
"use client";

import { useState } from "react";

export function BridgeConnection() {
  const [bridgeId, setBridgeId] = useState("");
  const [connected, setConnected] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleConnect = async () => {
    if (!bridgeId.trim()) {
      alert("Bitte Bridge ID eingeben");
      return;
    }

    setTesting(true);
    try {
      // Test connection by calling get_status
      const response = await fetch(`/api/bridges/${bridgeId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "get_status" }),
      });

      const result = await response.json();
      if (result.success) {
        setConnected(true);
        // Store bridgeId in localStorage
        localStorage.setItem("bridgeId", bridgeId);
      } else {
        alert(`Verbindung fehlgeschlagen: ${result.error}`);
        setConnected(false);
      }
    } catch (error) {
      alert(
        `Fehler: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      setConnected(false);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        value={bridgeId}
        onChange={(e) => setBridgeId(e.target.value)}
        placeholder="Bridge ID eingeben"
        disabled={connected}
      />
      <button onClick={handleConnect} disabled={testing || connected}>
        {testing ? "Verbinde..." : connected ? "Verbunden" : "Verbinden"}
      </button>
      {connected && <p>Verbunden mit Bridge: {bridgeId}</p>}
    </div>
  );
}
```

---

### 3. Command Helper Functions

**Pfad:** `lib/bridge-commands.ts`

**Funktion:** Wrapper-Funktionen für alle Bridge-Commands

```typescript
const BRIDGE_ID_KEY = "bridgeId";

function getBridgeId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(BRIDGE_ID_KEY);
}

async function sendCommand(command: string, payload?: Record<string, unknown>) {
  const bridgeId = getBridgeId();
  if (!bridgeId) {
    throw new Error("No bridge ID. Please connect to a bridge first.");
  }

  const response = await fetch(`/api/bridges/${bridgeId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, payload }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Command failed");
  }

  return response.json();
}

// Command helpers
export const bridgeCommands = {
  getStatus: () => sendCommand("get_status"),

  listOutputs: () => sendCommand("list_outputs"),

  engineConnect: (type: string, ip: string, port: number) =>
    sendCommand("engine_connect", { type, ip, port }),

  engineDisconnect: () => sendCommand("engine_disconnect"),

  engineGetStatus: () => sendCommand("engine_get_status"),

  engineGetMacros: () => sendCommand("engine_get_macros"),

  engineRunMacro: (macroId: number) =>
    sendCommand("engine_run_macro", { macroId }),

  engineStopMacro: (macroId: number) =>
    sendCommand("engine_stop_macro", { macroId }),
};
```

**Usage:**

```typescript
import { bridgeCommands } from "@/lib/bridge-commands";

// Get status
const status = await bridgeCommands.getStatus();

// Connect to engine
await bridgeCommands.engineConnect("atem", "192.168.1.100", 9910);

// Run macro
await bridgeCommands.engineRunMacro(1);
```

---

### 4. URL Parameter Handling entfernen

#### Zu entfernen:

- ❌ `?ip=...&port=...` Query Parameters
- ❌ `?tunnelUrl=...` Query Parameter
- ❌ `?useTunnel=true/false` Query Parameter
- ❌ IP/Port aus URL lesen und verwenden

#### Neu:

- ✅ Bridge ID aus `localStorage` lesen
- ✅ Bridge ID kann als Query Parameter übergeben werden: `?bridgeId=uuid` (optional, für Sharing)
- ✅ Bridge ID wird in `localStorage` gespeichert

**Migration:**

```typescript
// Vorher
const searchParams = new URLSearchParams(window.location.search);
const ip = searchParams.get("ip");
const port = searchParams.get("port");
const tunnelUrl = searchParams.get("tunnelUrl");

// Jetzt
const bridgeId =
  localStorage.getItem("bridgeId") ||
  new URLSearchParams(window.location.search).get("bridgeId");
```

---

### 5. WebSocket Handling (optional)

**Wichtig:** Die Web-App braucht **keinen WebSocket** mehr für die Bridge-Kommunikation.

#### Zu entfernen:

- ❌ WebSocket-Verbindung zu Bridge (`ws://localhost:8787/ws`)
- ❌ WebSocket-Verbindung zu Tunnel URL
- ❌ WebSocket Message Handling für Bridge Updates

#### Alternative (falls Real-time Updates benötigt):

- ✅ Polling: Regelmäßig `get_status` aufrufen (z.B. alle 2 Sekunden)
- ✅ Oder: Relay Server kann WebSocket für Real-time Updates bereitstellen (später)

**Polling Beispiel:**

```typescript
useEffect(() => {
  if (!connected) return;

  const interval = setInterval(async () => {
    try {
      const status = await bridgeCommands.getStatus();
      setBridgeStatus(status);
    } catch (error) {
      console.error("Status update failed:", error);
    }
  }, 2000); // Poll every 2 seconds

  return () => clearInterval(interval);
}, [connected]);
```

---

## Was muss entfernt werden?

### 1. Tunnel-bezogene UI-Komponenten

- ❌ Tunnel URL Anzeige
- ❌ "Connect via Tunnel" Button
- ❌ Tunnel Status Indicator
- ❌ `useTunnel` Flag Handling

### 2. Direkte Bridge-Verbindung

- ❌ Direkte HTTP-Calls zu Bridge IP/Port
- ❌ WebSocket-Verbindung zu Bridge
- ❌ IP/Port Konfiguration in UI
- ❌ Network Binding Auswahl (bleibt nur in Desktop App)

### 3. URL Parameter

- ❌ `ip`, `port`, `tunnelUrl`, `useTunnel` Query Parameters
- ❌ URL-basierte Bridge-Konfiguration

---

## Command Reference

### Unterstützte Commands

| Command             | Payload             | Response                     |
| ------------------- | ------------------- | ---------------------------- |
| `get_status`        | `{}`                | Bridge Status                |
| `list_outputs`      | `{}`                | `{output1: [], output2: []}` |
| `engine_connect`    | `{type, ip, port}`  | `{state: EngineState}`       |
| `engine_disconnect` | `{}`                | `{state: EngineState}`       |
| `engine_get_status` | `{}`                | `{state: EngineState}`       |
| `engine_get_macros` | `{}`                | `{macros: Macro[]}`          |
| `engine_run_macro`  | `{macroId: number}` | `{macroId, state}`           |
| `engine_stop_macro` | `{macroId: number}` | `{macroId, state}`           |

### Error Handling

Alle Commands können fehlschlagen mit:

```typescript
{
  "success": false,
  "error": "Error message"
}
```

**Häufige Fehler:**

- `"No bridge ID"` - Bridge ID nicht gesetzt
- `"Bridge not connected"` - Bridge ist nicht mit Relay verbunden
- `"Engine not connected"` - Engine ist nicht verbunden (für Engine-Commands)
- `"Invalid command"` - Unbekannter Command

---

## Migration Checklist

### Code-Änderungen

- [ ] API Route `/api/bridges/[bridgeId]/command` erstellen
- [ ] Bridge Connection UI Component erstellen
- [ ] Command Helper Functions erstellen
- [ ] Tunnel-bezogene UI entfernen
- [ ] IP/Port Eingabe entfernen
- [ ] URL Parameter Handling entfernen
- [ ] WebSocket-Verbindung entfernen (falls vorhanden)
- [ ] Polling für Status-Updates implementieren (optional)

### Testing

- [ ] Bridge ID Eingabe funktioniert
- [ ] Connect Button testet Verbindung
- [ ] Commands werden korrekt an Relay gesendet
- [ ] Responses werden korrekt verarbeitet
- [ ] Error Handling funktioniert
- [ ] Bridge ID wird in localStorage gespeichert

### Deployment

- [ ] `RELAY_API_URL` Environment Variable setzen
- [ ] API Route deployed
- [ ] UI Changes deployed
- [ ] Alte Tunnel-bezogene Code entfernt

---

## Beispiel: Vollständige Integration

```typescript
// app/page.tsx
"use client";

import { useState, useEffect } from "react";
import { BridgeConnection } from "@/components/BridgeConnection";
import { bridgeCommands } from "@/lib/bridge-commands";

export default function Home() {
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [macros, setMacros] = useState<any[]>([]);

  useEffect(() => {
    // Load bridge ID from localStorage
    const savedBridgeId = localStorage.getItem("bridgeId");
    if (savedBridgeId) {
      setBridgeId(savedBridgeId);
    }
  }, []);

  useEffect(() => {
    if (!bridgeId) return;

    // Poll status every 2 seconds
    const interval = setInterval(async () => {
      try {
        const result = await bridgeCommands.getStatus();
        if (result.success) {
          setStatus(result.data);
        }
      } catch (error) {
        console.error("Status update failed:", error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [bridgeId]);

  const handleRunMacro = async (macroId: number) => {
    if (!bridgeId) return;
    try {
      await bridgeCommands.engineRunMacro(macroId);
      // Refresh macros
      const result = await bridgeCommands.engineGetMacros();
      if (result.success) {
        setMacros(result.data.macros);
      }
    } catch (error) {
      alert(
        `Fehler: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  return (
    <div>
      <BridgeConnection
        onConnect={(id) => {
          setBridgeId(id);
          localStorage.setItem("bridgeId", id);
        }}
      />

      {bridgeId && status && (
        <div>
          <h2>Bridge Status</h2>
          <pre>{JSON.stringify(status, null, 2)}</pre>
        </div>
      )}

      {macros.length > 0 && (
        <div>
          <h2>Macros</h2>
          {macros.map((macro) => (
            <button key={macro.id} onClick={() => handleRunMacro(macro.id)}>
              {macro.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Zusammenfassung

### Was ändert sich?

1. **Kommunikation:** Direkt → Relay Server
2. **Identifikation:** IP/Port → Bridge ID (UUID)
3. **Connection:** Tunnel URL → Relay-Verbindung
4. **UI:** IP/Port Eingabe → Bridge ID Eingabe

### Was bleibt gleich?

- ✅ Command-Struktur (gleiche Commands)
- ✅ Response-Format (gleiche Datenstruktur)
- ✅ Engine-Commands (unverändert)
- ✅ Output-Management (unverändert)

### Vorteile

- ✅ Keine Firewall-Probleme (outbound WS)
- ✅ Zuverlässigere Verbindung
- ✅ Einfacheres Deployment
- ✅ Skalierbar (Relay Server kann viele Bridges handhaben)
