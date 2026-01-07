# Tricaster Adapter - Dokumentation

## Übersicht

Der Tricaster Adapter ermöglicht die Integration von NewTek Tricaster Systemen in die Broadify Bridge v2. Tricaster ist eine professionelle Video-Produktionsplattform mit Hardware- und Software-Komponenten.

## API-Übersicht

### Basis-Informationen

- **Protokoll**: HTTP REST API
- **Port**: 8080 (Standard)
- **Basis-URL**: `http://{ip}:8080`
- **Method**: GET, POST
- **Response Format**: JSON
- **Dokumentation**: Nicht vollständig öffentlich verfügbar

**Wichtig**: Die Tricaster API-Dokumentation ist nicht vollständig öffentlich zugänglich. Die Implementierung basiert auf bekannten API-Patterns und verwendet flexible Endpoint-Erkennung, um verschiedene Tricaster-Modelle und API-Versionen zu unterstützen.

## Implementierte Funktionen

### Verbindung (Connection)

#### Status Check
Prüft die Verbindung zum Tricaster-System.

**Versuchte Endpoints**:
- `GET /api/status`
- `GET /api` (Fallback)

**Verwendung**: Wird beim `connect()` verwendet, um die Verbindung zu testen.

### Macro-Funktionen

#### GetMacros
Ruft die Liste aller verfügbaren Macros ab.

**Versuchte Endpoints**:
- `GET /api/macros` (primär)
- `GET /api/macro` (Fallback)

**Erwartete Response-Formate**:

**Format 1 - Array**:
```json
[
  { "id": 1, "name": "Macro 1", "running": false },
  { "id": 2, "name": "Macro 2", "running": true }
]
```

**Format 2 - Object mit macros Array**:
```json
{
  "macros": [
    { "id": 1, "name": "Macro 1", "running": false },
    { "id": 2, "name": "Macro 2", "running": true }
  ]
}
```

**Format 3 - Object mit macro Array**:
```json
{
  "macro": [
    { "number": 1, "name": "Macro 1", "running": false },
    { "number": 2, "name": "Macro 2", "running": true }
  ]
}
```

**Verwendung**: Wird regelmäßig per Polling aufgerufen, um den Macro-Status zu aktualisieren.

#### RunMacro
Startet ein Macro.

**Versuchte Endpoints** (in dieser Reihenfolge):
1. `POST /api/macro/{id}/run`
2. `POST /api/macros/{id}/run`
3. `POST /api/macro/run` (mit Body: `{ "id": id }`)

**Request Body** (für Endpoint 3):
```json
{
  "id": 1
}
```

**Response**: Erfolgreich wenn HTTP 200 OK

**Verwendung**: Wird von `runMacro(id)` aufgerufen.

#### StopMacro
Stoppt ein laufendes Macro.

**Versuchte Endpoints** (in dieser Reihenfolge):
1. `POST /api/macro/{id}/stop`
2. `POST /api/macros/{id}/stop`
3. `POST /api/macro/stop` (mit Body: `{ "id": id }`)

**Request Body** (für Endpoint 3):
```json
{
  "id": 1
}
```

**Response**: Erfolgreich wenn HTTP 200 OK

**Verwendung**: Wird von `stopMacro(id)` aufgerufen.

## Flexible Endpoint-Erkennung

Da die Tricaster API-Dokumentation nicht vollständig verfügbar ist und sich die API-Struktur je nach Tricaster-Modell unterscheiden kann, verwendet der Adapter eine **flexible Endpoint-Erkennung**:

1. **Versuch mehrerer Endpoint-Varianten**: Der Adapter versucht verschiedene Endpoint-Formate nacheinander
2. **Erste erfolgreiche Response gewinnt**: Sobald ein Endpoint erfolgreich antwortet, wird dieser verwendet
3. **Graceful Degradation**: Falls alle Versuche fehlschlagen, wird ein aussagekräftiger Fehler geworfen

**Beispiel für runMacro**:
```typescript
// Try POST /api/macro/{id}/run
try {
  response = await this.makeRequest("POST", `/api/macro/${id}/run`);
  if (response.ok) return;
} catch { /* continue */ }

// Try POST /api/macros/{id}/run
try {
  response = await this.makeRequest("POST", `/api/macros/${id}/run`);
  if (response.ok) return;
} catch { /* continue */ }

// Try POST /api/macro/run with body
try {
  response = await this.makeRequest("POST", "/api/macro/run", { id });
  if (response.ok) return;
} catch { /* continue */ }

// All failed - throw error
throw new Error("Failed to run macro: All endpoint attempts failed");
```

## Macro ID System

**Wichtig**: Tricaster verwendet typischerweise **1-basierte Macro IDs**.

- Macro 1 in Tricaster UI = ID 1
- Macro 2 in Tricaster UI = ID 2
- etc.

**Hinweis**: Dies kann je nach Tricaster-Modell und API-Version variieren. Der Adapter validiert, dass IDs >= 1 sind.

## Response Parsing

Der Adapter unterstützt verschiedene JSON-Response-Formate:

### Array Format
```typescript
if (Array.isArray(json)) {
  for (const macro of json) {
    macros.push({
      id: parseInt(String(macro.id || macro.number), 10),
      name: String(macro.name || `Macro ${macro.id || macro.number}`),
      status: macro.running === true ? "running" : "idle",
    });
  }
}
```

### Object mit macros Array
```typescript
if (json.macros && Array.isArray(json.macros)) {
  // Process macros array
}
```

### Object mit macro Array
```typescript
if (json.macro && Array.isArray(json.macro)) {
  // Process macro array
}
```

**Unterstützte Felder**:
- `id` oder `number`: Macro ID
- `name`: Macro Name
- `running`: Boolean (wird zu "running" oder "idle" Status konvertiert)

## Polling-Mechanismus

Da Tricaster kein Event-System wie ATEM hat, verwendet der Adapter **Polling** für Status-Updates:

- **Intervall**: 2 Sekunden (2000ms)
- **Nur aktiv**: Wenn `status === "connected"`
- **Funktion**: Ruft `GetMacros` auf, um Macro-Status zu aktualisieren

**Implementierung**:
```typescript
private startPolling(): void {
  this.pollingInterval = setInterval(() => {
    if (this.state.status === "connected") {
      this.updateMacrosFromApi().catch(/* error handling */);
    } else {
      this.stopPolling();
    }
  }, this.pollingIntervalMs);
}
```

## Error Handling

### Connection Errors

Der Adapter erkennt verschiedene Netzwerk-Fehler und konvertiert sie in spezifische `EngineError` Instanzen:

- **ECONNREFUSED / refused**: `createConnectionRefusedError()`
- **ENOTFOUND / EHOSTUNREACH / getaddrinfo**: `createDeviceUnreachableError()`
- **ETIMEDOUT / timeout / aborted**: `createConnectionTimeoutError()`
- **Andere**: `createNetworkError()`

### Request Timeout

- **Timeout**: 5 Sekunden pro Request
- **Connection Timeout**: 10 Sekunden beim Verbinden

### Error States

Bei Fehlern wird der Status auf `"error"` gesetzt und eine Fehlermeldung im State gespeichert:

```typescript
this.setState({
  status: "error",
  error: engineError.message,
});
```

## Authentication

**Hinweis**: Der Adapter unterstützt aktuell keine Authentifizierung, ist aber vorbereitet:

```typescript
private authHeader: string | null = null;

// In makeRequest:
if (this.authHeader) {
  headers["Authorization"] = this.authHeader;
}
```

Falls Authentication benötigt wird, kann dies später hinzugefügt werden:
- Basic Auth: `Basic {base64(username:password)}`
- Bearer Token: `Bearer {token}`

## Beispiel-Requests

### Verbindung testen
```bash
curl "http://192.168.1.100:8080/api/status"
```

### Alle Macros abrufen
```bash
curl "http://192.168.1.100:8080/api/macros"
```

### Macro 1 starten (verschiedene Varianten)
```bash
# Variante 1
curl -X POST "http://192.168.1.100:8080/api/macro/1/run"

# Variante 2
curl -X POST "http://192.168.1.100:8080/api/macros/1/run"

# Variante 3
curl -X POST "http://192.168.1.100:8080/api/macro/run" \
  -H "Content-Type: application/json" \
  -d '{"id": 1}'
```

## Implementierungs-Details

### Datei
`apps/bridge/src/services/engine/adapters/tricaster-adapter.ts`

### Abhängigkeiten
- Keine externen npm Packages (verwendet native `fetch` API)
- Node.js 22.12+ erforderlich (für native `fetch`)

### TypeScript-Typen
- Implementiert `EngineAdapter` Interface
- Verwendet `EngineStateT`, `MacroT`, `EngineStatusT` aus `engine-types.ts`

### State Management
- Verwendet `EventEmitter` für State-Change-Events
- State wird bei jedem Update via `setState()` aktualisiert
- `onStateChange()` Callback wird bei jedem State-Update aufgerufen

## Bekannte Einschränkungen

1. **Fehlende öffentliche Dokumentation**: Die vollständige Tricaster API-Dokumentation ist nicht öffentlich verfügbar. Die Implementierung basiert auf bekannten Patterns und Reverse-Engineering.

2. **Modell-spezifische Unterschiede**: Verschiedene Tricaster-Modelle können unterschiedliche API-Strukturen haben. Die flexible Endpoint-Erkennung hilft, aber es kann sein, dass nicht alle Modelle unterstützt werden.

3. **Keine Authentication**: Aktuell wird keine Authentifizierung unterstützt. Falls Tricaster Authentication aktiviert ist, müssen die Credentials in der Config hinzugefügt werden.

4. **Polling Overhead**: Polling alle 2 Sekunden erzeugt Netzwerk-Traffic. Dies ist akzeptabel für die meisten Anwendungsfälle, aber könnte bei vielen gleichzeitigen Verbindungen problematisch sein.

5. **Keine WebSocket-Unterstützung**: Tricaster unterstützt möglicherweise keine WebSockets für Echtzeit-Updates, daher ist Polling notwendig.

## Testing

### Lokales Testing

1. Stelle sicher, dass Tricaster läuft und die API aktiviert ist
2. Finde die IP-Adresse des Tricaster-Systems
3. Verbinde Bridge mit `{tricaster-ip}:8080`
4. Teste Macro-Operationen

### Beispiel-Test-Szenario

```typescript
// Connect
await adapter.connect({ type: "tricaster", ip: "192.168.1.100", port: 8080 });

// Get macros
const macros = adapter.getMacros();
console.log(macros); // [{ id: 1, name: "Macro 1", status: "idle" }, ...]

// Run macro
await adapter.runMacro(1);

// Check status (after polling update)
const updatedMacros = adapter.getMacros();
console.log(updatedMacros); // [{ id: 1, name: "Macro 1", status: "running" }, ...]

// Stop macro
await adapter.stopMacro(1);
```

## Troubleshooting

### Verbindungsprobleme

1. **Port 8080 nicht erreichbar**: Prüfe, ob die Tricaster API aktiviert ist
2. **404 Fehler**: Die API-Endpunkte könnten anders sein - prüfe die Tricaster-Dokumentation
3. **Timeout**: Prüfe Netzwerk-Verbindung und Firewall-Einstellungen

### Macro-Operationen schlagen fehl

1. **Alle Endpoint-Varianten fehlgeschlagen**: Die Tricaster-API-Struktur könnte anders sein als erwartet
2. **Macro ID ungültig**: Prüfe, ob die Macro IDs korrekt sind (möglicherweise 0-based statt 1-based)
3. **Authentication erforderlich**: Falls Authentication aktiviert ist, muss diese implementiert werden

## Referenzen

- [NewTek Tricaster Website](https://www.newtek.com/tricaster/)
- **Hinweis**: Vollständige API-Dokumentation ist nicht öffentlich verfügbar. Kontaktiere NewTek Support für detaillierte API-Informationen.

