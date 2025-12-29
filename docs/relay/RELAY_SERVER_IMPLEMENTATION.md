# Relay Server Implementation Guide

## Übersicht

Diese Dokumentation beschreibt, was der Relay Server implementieren muss, um nahtlos mit der Bridge und der Web-App zu kommunizieren.

**Relay Server URL:** `wss://broadify-relay.fly.dev` (WebSocket) / `https://broadify-relay.fly.dev` (HTTP)

---

## 1. WebSocket Server (Bridge → Relay)

### Endpoint

- **Pfad:** `/` (Root, kein `/ws` Pfad)
- **Protokoll:** WSS (WebSocket Secure über TLS)
- **Bind:** `0.0.0.0` (für Fly.io)

### Bridge Registration

**Bridge sendet nach Verbindung:**
```json
{
  "type": "bridge_hello",
  "bridgeId": "550e8400-e29b-41d4-a716-446655440000",
  "version": "0.1.0"
}
```

**Relay Server muss:**
- `bridgeId` extrahieren
- WebSocket-Verbindung in Registry speichern: `bridges.set(bridgeId, websocket)`
- Optional: Logging für Debugging

### Command Forwarding

**Relay Server empfängt von Web-App (HTTP):**
```json
{
  "bridgeId": "550e8400-e29b-41d4-a716-446655440000",
  "command": "get_status",
  "payload": {}
}
```

**Relay Server sendet an Bridge (WebSocket):**
```json
{
  "type": "command",
  "requestId": "unique-request-id-12345",
  "command": "get_status",
  "payload": {}
}
```

**Wichtig:** `requestId` muss eindeutig sein (UUID oder Timestamp + Random)

### Response Handling

**Bridge sendet zurück:**
```json
{
  "type": "command_result",
  "requestId": "unique-request-id-12345",
  "success": true,
  "data": { ... }
}
```

**Relay Server muss:**
- `requestId` matchen mit pending Request
- Response an Web-App weiterleiten (HTTP Response)
- Timeout nach 10 Sekunden (falls keine Response)

---

## 2. HTTP Endpoint (Web-App → Relay)

### POST `/relay/command`

**URL:** `https://broadify-relay.fly.dev/relay/command`

**Request:**
```json
{
  "bridgeId": "string (UUID)",
  "command": "string",
  "payload": {} // Optional
}
```

**Response:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Oder bei Fehler:**
```json
{
  "success": false,
  "error": "Error message"
}
```

**HTTP Status Codes:**
- `200 OK` - Request verarbeitet (auch bei `success: false`)
- `400 Bad Request` - Ungültiger Request (fehlende Parameter)
- `404 Not Found` - Bridge nicht verbunden
- `500 Internal Server Error` - Server-Fehler

---

## 3. Bridge Registry

### In-Memory Storage (MVP)

```typescript
// Bridge Registry: bridgeId → WebSocket
const bridges = new Map<string, WebSocket>();

// Pending Requests: requestId → Promise
const pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();
```

### Operations

**Register Bridge:**
```typescript
function registerBridge(bridgeId: string, ws: WebSocket) {
  bridges.set(bridgeId, ws);
  
  // Cleanup on disconnect
  ws.on('close', () => {
    bridges.delete(bridgeId);
  });
}
```

**Find Bridge:**
```typescript
function getBridge(bridgeId: string): WebSocket | undefined {
  const ws = bridges.get(bridgeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return undefined;
  }
  return ws;
}
```

---

## 4. Request/Response Matching

### Flow

1. Web-App sendet HTTP POST `/relay/command`
2. Relay generiert `requestId` (UUID)
3. Relay speichert Promise in `pendingRequests`
4. Relay sendet Command an Bridge via WebSocket
5. Bridge verarbeitet Command und sendet `command_result` zurück
6. Relay matched `requestId` und resolved Promise
7. Relay sendet HTTP Response an Web-App

### Implementation

```typescript
async function handleCommand(req: Request): Promise<Response> {
  const { bridgeId, command, payload } = await req.json();
  
  // Find bridge
  const bridgeWs = bridges.get(bridgeId);
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
    return new Response(JSON.stringify({
      success: false,
      error: "Bridge not connected"
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // Generate request ID
  const requestId = crypto.randomUUID();
  
  // Create promise for response
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Command timeout"));
    }, 10000); // 10 seconds
    
    pendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(error);
      },
      timeout
    });
  });
  
  // Send command to bridge
  bridgeWs.send(JSON.stringify({
    type: "command",
    requestId,
    command,
    payload
  }));
  
  // Wait for response
  try {
    const result = await promise;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 200, // HTTP 200, aber success: false
      headers: { "Content-Type": "application/json" }
    });
  }
}
```

### WebSocket Message Handler

```typescript
bridgeWs.on('message', (data: Buffer) => {
  try {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'command_result') {
      const { requestId, success, data, error } = message;
      const pending = pendingRequests.get(requestId);
      
      if (pending) {
        if (success) {
          pending.resolve({ success: true, data });
        } else {
          pending.resolve({ success: false, error });
        }
      }
    }
  } catch (error) {
    console.error('Error parsing bridge message:', error);
  }
});
```

---

## 5. Unterstützte Commands

Der Relay Server muss alle diese Commands unterstützen:

### Bridge Commands

| Command | Payload | Beschreibung |
|---------|---------|--------------|
| `get_status` | `{}` | Bridge Status abrufen |
| `list_outputs` | `{}` | Verfügbare Outputs auflisten |

### Engine Commands

| Command | Payload | Beschreibung |
|---------|---------|--------------|
| `engine_connect` | `{type: "atem"\|"tricaster"\|"vmix", ip: string, port: number}` | Engine verbinden |
| `engine_disconnect` | `{}` | Engine trennen |
| `engine_get_status` | `{}` | Engine Status abrufen |
| `engine_get_macros` | `{}` | Macros auflisten |
| `engine_run_macro` | `{macroId: number}` | Macro ausführen |
| `engine_stop_macro` | `{macroId: number}` | Macro stoppen |

**Wichtig:** Der Relay Server muss diese Commands **nicht** validieren oder verstehen. Er leitet sie einfach 1:1 an die Bridge weiter. Die Bridge validiert und verarbeitet die Commands.

---

## 6. Error Handling

### Bridge nicht verbunden

```json
{
  "success": false,
  "error": "Bridge not connected"
}
```

**HTTP Status:** `404 Not Found`

### Command Timeout

```json
{
  "success": false,
  "error": "Command timeout"
}
```

**HTTP Status:** `200 OK` (aber `success: false`)

### Ungültiger Request

```json
{
  "success": false,
  "error": "Invalid request: missing bridgeId"
}
```

**HTTP Status:** `400 Bad Request`

---

## 7. Health Check Endpoint

### GET `/health`

**Response:**
```json
{
  "ok": true
}
```

**Optional:** Kann auch Bridge-Statistiken zurückgeben:
```json
{
  "ok": true,
  "bridgesConnected": 5,
  "uptime": 12345
}
```

---

## 8. Implementation Checklist

### WebSocket Server

- [ ] WebSocket auf Root `/` (nicht `/ws`)
- [ ] `bridge_hello` Message empfangen und Bridge registrieren
- [ ] `command_result` Messages empfangen und an Web-App weiterleiten
- [ ] Cleanup bei WebSocket-Close (Bridge deregistrieren)
- [ ] Error Handling für ungültige Messages

### HTTP Endpoint

- [ ] `POST /relay/command` implementieren
- [ ] Request validieren (`bridgeId`, `command` erforderlich)
- [ ] Bridge in Registry finden
- [ ] `requestId` generieren
- [ ] Command an Bridge weiterleiten
- [ ] Response von Bridge abwarten (max 10s)
- [ ] HTTP Response an Web-App senden
- [ ] Timeout Handling

### Bridge Registry

- [ ] In-Memory Map: `bridgeId → WebSocket`
- [ ] Pending Requests Map: `requestId → Promise`
- [ ] Cleanup bei Disconnect
- [ ] Cleanup bei Timeout

### Error Handling

- [ ] Bridge nicht verbunden → 404
- [ ] Ungültiger Request → 400
- [ ] Timeout → 200 mit `success: false`
- [ ] Server-Fehler → 500

---

## 9. Testing

### WebSocket Test

```bash
# Mit wscat
npx wscat -c wss://broadify-relay.fly.dev

# Nach Verbindung senden:
{"type":"bridge_hello","bridgeId":"test-123","version":"0.1.0"}
```

### HTTP Command Test

```bash
curl -X POST https://broadify-relay.fly.dev/relay/command \
  -H "Content-Type: application/json" \
  -d '{
    "bridgeId": "test-bridge-id",
    "command": "get_status",
    "payload": {}
  }'
```

**Erwartet:**
- Wenn Bridge verbunden: `{"success": true, "data": {...}}`
- Wenn Bridge nicht verbunden: `{"success": false, "error": "Bridge not connected"}` (404)

---

## 10. Wichtige Hinweise

### Request Timeout

**10 Sekunden** ist empfohlen, da:
- `engine_connect` kann bis zu 10 Sekunden dauern
- Andere Commands sind schneller (< 1s)

### Bridge Registry

**MVP:** In-Memory Map ist ausreichend.

**Später (Production):**
- Redis für persistente Bridge-Registry
- Database für Bridge-Metadaten
- Multi-Instance Support

### Error Messages

Fehlermeldungen sollten **klar und hilfreich** sein:
- ✅ `"Bridge not connected"` - Bridge ist nicht verbunden
- ✅ `"Command timeout"` - Bridge hat nicht rechtzeitig geantwortet
- ❌ `"Error"` - Zu generisch

### WebSocket Cleanup

**Wichtig:** Bei WebSocket-Close:
1. Bridge aus Registry entfernen
2. Alle pending Requests für diese Bridge canceln
3. Timeouts löschen

---

## 11. Beispiel-Implementation (Pseudocode)

```typescript
// Bridge Registry
const bridges = new Map<string, WebSocket>();
const pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'bridge_hello') {
      // Register bridge
      bridges.set(message.bridgeId, ws);
      
      // Cleanup on close
      ws.on('close', () => {
        bridges.delete(message.bridgeId);
        // Cancel pending requests
        for (const [requestId, pending] of pendingRequests.entries()) {
          // Check if request is for this bridge (optional)
          pending.reject(new Error('Bridge disconnected'));
        }
      });
    } else if (message.type === 'command_result') {
      // Match request and resolve promise
      const pending = pendingRequests.get(message.requestId);
      if (pending) {
        if (message.success) {
          pending.resolve({ success: true, data: message.data });
        } else {
          pending.resolve({ success: false, error: message.error });
        }
      }
    }
  });
});

// HTTP Endpoint
app.post('/relay/command', async (req, res) => {
  const { bridgeId, command, payload } = req.body;
  
  // Validate
  if (!bridgeId || !command) {
    return res.status(400).json({
      success: false,
      error: 'Missing bridgeId or command'
    });
  }
  
  // Find bridge
  const bridgeWs = bridges.get(bridgeId);
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
    return res.status(404).json({
      success: false,
      error: 'Bridge not connected'
    });
  }
  
  // Generate request ID
  const requestId = crypto.randomUUID();
  
  // Create promise
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Command timeout'));
    }, 10000);
    
    pendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(error);
      },
      timeout
    });
  });
  
  // Send command to bridge
  bridgeWs.send(JSON.stringify({
    type: 'command',
    requestId,
    command,
    payload: payload || {}
  }));
  
  // Wait for response
  try {
    const result = await promise;
    res.status(200).json(result);
  } catch (error) {
    res.status(200).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
```

---

## 12. Zusammenfassung

### Was der Relay Server implementieren muss:

1. ✅ **WebSocket Server** auf Root `/`
2. ✅ **Bridge Registry** (In-Memory Map)
3. ✅ **HTTP Endpoint** `POST /relay/command`
4. ✅ **Request/Response Matching** (requestId)
5. ✅ **Timeout Handling** (10s)
6. ✅ **Error Handling** (Bridge nicht verbunden, etc.)

### Was der Relay Server NICHT machen muss:

- ❌ Commands validieren (Bridge macht das)
- ❌ Command-Logik implementieren (Bridge macht das)
- ❌ Authentication (MVP, später hinzufügen)

### Wichtige URLs:

- **WebSocket:** `wss://broadify-relay.fly.dev`
- **HTTP API:** `https://broadify-relay.fly.dev/relay/command`
- **Health:** `https://broadify-relay.fly.dev/health`

---

## 13. Message Protocol Reference

### Bridge → Relay

**Bridge Hello:**
```json
{
  "type": "bridge_hello",
  "bridgeId": "uuid",
  "version": "0.1.0"
}
```

**Command Result:**
```json
{
  "type": "command_result",
  "requestId": "uuid",
  "success": true,
  "data": { ... }
}
```

### Relay → Bridge

**Command:**
```json
{
  "type": "command",
  "requestId": "uuid",
  "command": "get_status",
  "payload": {}
}
```

---

## 14. Testing Endpoints

### Health Check
```bash
curl https://broadify-relay.fly.dev/health
```

### Command Test (Bridge muss verbunden sein)
```bash
curl -X POST https://broadify-relay.fly.dev/relay/command \
  -H "Content-Type: application/json" \
  -d '{"bridgeId":"your-bridge-id","command":"get_status","payload":{}}'
```

---

## Support

Bei Fragen zur Bridge-Implementation, siehe:
- `docs/BRIDGE_ARCHITECTURE.md` - Architektur-Übersicht
- `docs/RELAY_COMPATIBILITY_CHECK.md` - Kompatibilitätsprüfung

