# Macro API Responses

Dokumentation der Response-Strukturen für die Makro-Endpunkte der Bridge API.

## Übersicht

Alle Makro-Endpunkte verwenden eine konsistente Response-Struktur:

- **Erfolgreiche Responses**: `success: true` + Daten
- **Fehler-Responses**: `success: false` + `error` + `message`
- **HTTP-Statuscodes**: 200 (Erfolg), 400 (Bad Request), 500 (Server Error), 503 (Service Unavailable)

---

## Endpunkte

### 1. GET /engine/macros

Ruft alle verfügbaren Makros vom verbundenen Engine ab.

#### Request

```http
GET /engine/macros
```

#### Success Response (HTTP 200)

```json
{
  "success": true,
  "macros": [
    {
      "id": 0,
      "name": "Macro 1",
      "status": "idle"
    },
    {
      "id": 1,
      "name": "Macro 2",
      "status": "running"
    },
    {
      "id": 2,
      "name": "Macro 3",
      "status": "recording"
    }
  ]
}
```

**Macro Status Werte:**

- `idle`: Makro ist nicht aktiv
- `running`: Makro wird aktuell ausgeführt
- `recording`: Makro wird aktuell aufgezeichnet

#### Error Response - Engine nicht verbunden (HTTP 503)

```json
{
  "success": false,
  "error": "Engine not connected",
  "message": "Engine status: disconnected",
  "macros": []
}
```

#### Error Response - Server-Fehler (HTTP 500)

```json
{
  "success": false,
  "error": "Failed to get macros",
  "message": "Fehlermeldung",
  "macros": []
}
```

---

### 2. POST /engine/macros/:id/run

Startet die Ausführung eines Makros.

#### Request

```http
POST /engine/macros/:id/run
```

**Parameter:**

- `id` (URL-Parameter): Makro-ID (0-basiert, Slot 1 = ID 0)

#### Success Response (HTTP 200)

```json
{
  "success": true,
  "macroId": 0,
  "state": {
    "status": "connected",
    "macros": [
      {
        "id": 0,
        "name": "Macro 1",
        "status": "running"
      },
      {
        "id": 1,
        "name": "Macro 2",
        "status": "idle"
      }
    ],
    "ip": "192.168.1.100",
    "port": 9910,
    "type": "atem",
    "lastUpdate": 1234567890
  }
}
```

**Hinweis:** Der `state` enthält den vollständigen Engine-Status nach der Makro-Ausführung, einschließlich aktualisierter Makro-Status.

#### Error Response - Ungültige Macro ID (HTTP 400)

```json
{
  "success": false,
  "error": "Invalid macro ID",
  "message": "Macro ID must be a number"
}
```

**Ursache:** Der `id` Parameter konnte nicht als Zahl geparst werden.

#### Error Response - Engine nicht verbunden (HTTP 503)

```json
{
  "success": false,
  "error": "Engine not connected",
  "message": "Engine is not connected"
}
```

**Ursache:** Der Engine-Adapter ist nicht verbunden oder die Verbindung wurde getrennt.

#### Error Response - Server-Fehler (HTTP 500)

```json
{
  "success": false,
  "error": "Failed to run macro",
  "message": "Failed to run macro 0: Connection timeout"
}
```

**Mögliche Ursachen:**

- Makro-ID existiert nicht
- Engine unterstützt Makros nicht
- Netzwerk-Fehler
- Timeout bei der Ausführung

---

### 3. POST /engine/macros/:id/stop

Stoppt die Ausführung eines laufenden Makros.

#### Request

```http
POST /engine/macros/:id/stop
```

**Parameter:**

- `id` (URL-Parameter): Makro-ID (0-basiert, Slot 1 = ID 0)

#### Success Response (HTTP 200)

```json
{
  "success": true,
  "macroId": 0,
  "state": {
    "status": "connected",
    "macros": [
      {
        "id": 0,
        "name": "Macro 1",
        "status": "idle"
      },
      {
        "id": 1,
        "name": "Macro 2",
        "status": "idle"
      }
    ],
    "ip": "192.168.1.100",
    "port": 9910,
    "type": "atem",
    "lastUpdate": 1234567890
  }
}
```

**Hinweis:** Der `state` enthält den vollständigen Engine-Status nach dem Stoppen des Makros.

#### Error Response - Ungültige Macro ID (HTTP 400)

```json
{
  "success": false,
  "error": "Invalid macro ID",
  "message": "Macro ID must be a number"
}
```

**Ursache:** Der `id` Parameter konnte nicht als Zahl geparst werden.

#### Error Response - Engine nicht verbunden (HTTP 503)

```json
{
  "success": false,
  "error": "Engine not connected",
  "message": "Engine is not connected"
}
```

**Ursache:** Der Engine-Adapter ist nicht verbunden oder die Verbindung wurde getrennt.

#### Error Response - Server-Fehler (HTTP 500)

```json
{
  "success": false,
  "error": "Failed to stop macro",
  "message": "Failed to stop macro 0: macroStop method not available in atem-connection"
}
```

**Mögliche Ursachen:**

- Makro-ID existiert nicht
- Engine unterstützt `macroStop` nicht (z.B. ältere ATEM-Versionen)
- Makro läuft nicht
- Netzwerk-Fehler

---

## TypeScript Typen

Die Response-Typen sind in `types.d.ts` definiert:

```typescript
export type EventPayloadMapping = {
  engineGetMacros: {
    success: boolean;
    error?: string;
    macros?: MacroT[];
  };
  engineRunMacro: {
    success: boolean;
    error?: string;
    macroId?: number;
    state?: EngineStateT;
  };
  engineStopMacro: {
    success: boolean;
    error?: string;
    macroId?: number;
    state?: EngineStateT;
  };
};
```

---

## Fehlerbehandlung im Client

Der Client (`src/electron/main.ts`) behandelt Fehler auf zwei Ebenen:

### 1. HTTP-Fehlercodes

Wenn die Bridge einen HTTP-Fehlercode (400, 500, 503) zurückgibt, wirft `bridgeApiRequest` eine Exception:

```typescript
try {
  const result = await bridgeApiRequest("/engine/macros");
  // Erfolg
} catch (error) {
  // HTTP-Fehler wurde geworfen
  return { success: false, error: error.message };
}
```

### 2. Success-Flag in Response

Zusätzlich prüft der Client auch das `success`-Flag in erfolgreichen HTTP-Responses:

```typescript
const result = await bridgeApiRequest("/engine/macros");

if (result.success === false) {
  return {
    success: false,
    error: result.error || result.message || "Failed to get macros",
    macros: result.macros || [],
  };
}
```

Diese defensive Programmierung stellt sicher, dass Fehler korrekt behandelt werden, auch wenn die Bridge einen HTTP 200 mit `success: false` zurückgibt.

---

## Best Practices

### 1. Immer `success` prüfen

```typescript
// ✅ Gut
if (response.success) {
  // Erfolgreiche Verarbeitung
} else {
  // Fehlerbehandlung
}

// ❌ Schlecht
if (response.macros) {
  // Kann fehlschlagen, wenn success: false
}
```

### 2. Fehlermeldungen anzeigen

```typescript
if (!response.success) {
  console.error(response.error || response.message);
  // UI-Fehlermeldung anzeigen
}
```

### 3. Fallback-Werte verwenden

```typescript
const macros = response.macros || [];
const error = response.error || "Unknown error";
```

---

## Beispiel: Vollständiger Request/Response-Zyklus

### Request

```http
POST /engine/macros/0/run HTTP/1.1
Host: localhost:8787
Content-Type: application/json
```

### Success Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "macroId": 0,
  "state": {
    "status": "connected",
    "macros": [
      {
        "id": 0,
        "name": "Macro 1",
        "status": "running"
      }
    ],
    "ip": "192.168.1.100",
    "port": 9910,
    "type": "atem",
    "lastUpdate": 1234567890
  }
}
```

### Error Response

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "success": false,
  "error": "Engine not connected",
  "message": "Engine is not connected"
}
```

---

## WebSocket Updates

Zusätzlich zu den HTTP-Responses sendet die Bridge auch WebSocket-Updates für Makro-Statusänderungen:

### Macro Status Update

```json
{
  "type": "engine.macroStatus",
  "macroId": 0,
  "status": "running"
}
```

### Macros Update

```json
{
  "type": "engine.macros",
  "macros": [
    {
      "id": 0,
      "name": "Macro 1",
      "status": "running"
    }
  ]
}
```

Diese Updates werden automatisch gesendet, wenn sich der Makro-Status ändert, ohne dass ein neuer Request erforderlich ist.

---

## Implementierungsdetails

### Bridge-Seite (`apps/bridge/src/routes/engine.ts`)

- Alle Fehler-Responses enthalten `success: false`
- HTTP-Statuscodes werden korrekt gesetzt (400, 500, 503)
- Fehlermeldungen werden aus Exceptions extrahiert
- Bei Erfolg wird der vollständige Engine-State zurückgegeben

### Client-Seite (`src/electron/main.ts`)

- Prüft sowohl HTTP-Statuscodes als auch `success`-Flag
- Gibt konsistente IPC-Responses zurück
- Fehler werden korrekt an die UI weitergegeben

---

## Changelog

- **2024-XX-XX**: Konsistente `success`-Flags in allen Responses hinzugefügt
- **2024-XX-XX**: Defensive Fehlerbehandlung im Client implementiert
- **2024-XX-XX**: Dokumentation erstellt
