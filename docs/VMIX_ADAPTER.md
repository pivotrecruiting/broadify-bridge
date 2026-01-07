# vMix Adapter - Dokumentation

## Übersicht

Der vMix Adapter ermöglicht die Integration von vMix Software Switchern in die Broadify Bridge v2. vMix ist eine professionelle Video-Produktionssoftware, die auf Windows läuft und eine HTTP-basierte API für die Steuerung bereitstellt.

## API-Übersicht

### Basis-Informationen

- **Protokoll**: HTTP REST API
- **Port**: 8088 (Standard, konfigurierbar in vMix)
- **Basis-URL**: `http://{ip}:8088`
- **Method**: GET (für alle Funktionen)
- **Response Format**: XML (Standard) oder JSON (mit Format-Parameter)
- **Offizielle Dokumentation**: https://www.vmix.com/help28/DeveloperAPI.html

### API-Endpunkt Format

Alle vMix API-Aufrufe folgen diesem Format:

```
http://{ip}:8088/api/?Function={FunctionName}&{Parameter1}={Value1}&{Parameter2}={Value2}
```

**Beispiel**:

```
http://127.0.0.1:8088/api/?Function=Fade&Duration=1000
```

## Implementierte Funktionen

### Verbindung (Connection)

#### GetVersion

Prüft die Verbindung und gibt die vMix-Version zurück.

**Request**:

```
GET http://{ip}:8088/api/?Function=GetVersion
```

**Response** (XML):

```xml
<vmix>
  <version>28.0.0.65</version>
</vmix>
```

**Verwendung**: Wird beim `connect()` verwendet, um die Verbindung zu testen.

### Macro-Funktionen

#### GetMacros

Ruft die Liste aller verfügbaren Macros ab.

**Request**:

```
GET http://{ip}:8088/api/?Function=GetMacros
```

**Response** (XML):

```xml
<vmix>
  <macros>
    <macro number="1" name="Macro 1" running="False"/>
    <macro number="2" name="Macro 2" running="True"/>
  </macros>
</vmix>
```

**Response** (JSON, mit `&Format=JSON`):

```json
{
  "macros": [
    { "number": 1, "name": "Macro 1", "running": false },
    { "number": 2, "name": "Macro 2", "running": true }
  ]
}
```

**Verwendung**: Wird regelmäßig per Polling aufgerufen, um den Macro-Status zu aktualisieren.

#### MacroStart

Startet ein Macro.

**Request**:

```
GET http://{ip}:8088/api/?Function=MacroStart&Input={id}
```

**Parameter**:

- `Input` (number): Macro ID (1-based)

**Beispiel**:

```
GET http://127.0.0.1:8088/api/?Function=MacroStart&Input=1
```

**Response**: Erfolgreich wenn HTTP 200 OK

**Verwendung**: Wird von `runMacro(id)` aufgerufen.

#### MacroStop

Stoppt ein laufendes Macro.

**Request**:

```
GET http://{ip}:8088/api/?Function=MacroStop&Input={id}
```

**Parameter**:

- `Input` (number): Macro ID (1-based)

**Beispiel**:

```
GET http://127.0.0.1:8088/api/?Function=MacroStop&Input=1
```

**Response**: Erfolgreich wenn HTTP 200 OK

**Verwendung**: Wird von `stopMacro(id)` aufgerufen.

## Macro ID System

**Wichtig**: vMix verwendet **1-basierte Macro IDs**.

- Macro 1 in vMix UI = ID 1
- Macro 2 in vMix UI = ID 2
- etc.

Dies unterscheidet sich von ATEM, das 0-basierte IDs verwendet (Slot 1 = ID 0).

## Response Parsing

### XML Parsing

Der Adapter parst XML-Responses mit einem einfachen Regex-basierten Ansatz:

```typescript
const macroMatches = responseText.matchAll(
  /<macro\s+number="(\d+)"\s+name="([^"]*)"\s+running="([^"]*)"/g
);
```

**Unterstützte Attribute**:

- `number`: Macro ID
- `name`: Macro Name
- `running`: "True" oder "False" (wird zu boolean konvertiert)

### JSON Parsing

Falls JSON-Format verwendet wird (mit `&Format=JSON`), wird die Response als JSON geparst:

```typescript
const json = JSON.parse(responseText);
if (json.macros && Array.isArray(json.macros)) {
  // Process macros array
}
```

**Hinweis**: Aktuell wird kein `Format=JSON` Parameter gesendet, da XML das Standard-Format ist und gut funktioniert.

## Polling-Mechanismus

Da vMix kein Event-System wie ATEM hat, verwendet der Adapter **Polling** für Status-Updates:

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

## Beispiel-Requests

### Verbindung testen

```bash
curl "http://127.0.0.1:8088/api/?Function=GetVersion"
```

### Alle Macros abrufen

```bash
curl "http://127.0.0.1:8088/api/?Function=GetMacros"
```

### Macro 1 starten

```bash
curl "http://127.0.0.1:8088/api/?Function=MacroStart&Input=1"
```

### Macro 1 stoppen

```bash
curl "http://127.0.0.1:8088/api/?Function=MacroStop&Input=1"
```

## Konfiguration in vMix

Die vMix API muss in den vMix-Einstellungen aktiviert werden:

1. Öffne vMix
2. Gehe zu **Settings** → **Web**
3. Aktiviere **Enable Web API**
4. Setze den **Port** (Standard: 8088)
5. Optional: Konfiguriere **Authentication** (wird aktuell nicht unterstützt)

## Implementierungs-Details

### Datei

`apps/bridge/src/services/engine/adapters/vmix-adapter.ts`

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

1. **Keine Authentication**: Aktuell wird keine Authentifizierung unterstützt. Falls vMix Authentication aktiviert ist, müssen die Credentials in der Config hinzugefügt werden.

2. **XML Parsing**: Aktuell wird ein einfacher Regex-basierter XML-Parser verwendet. Für komplexere XML-Strukturen könnte `fast-xml-parser` verwendet werden.

3. **Polling Overhead**: Polling alle 2 Sekunden erzeugt Netzwerk-Traffic. Dies ist akzeptabel für die meisten Anwendungsfälle, aber könnte bei vielen gleichzeitigen Verbindungen problematisch sein.

4. **Keine WebSocket-Unterstützung**: vMix unterstützt keine WebSockets für Echtzeit-Updates, daher ist Polling notwendig.

## Testing

### Lokales Testing

1. Installiere vMix (kostenlose Testversion verfügbar)
2. Aktiviere Web API in den Einstellungen
3. Verbinde Bridge mit `localhost:8088`
4. Teste Macro-Operationen

### Beispiel-Test-Szenario

```typescript
// Connect
await adapter.connect({ type: "vmix", ip: "127.0.0.1", port: 8088 });

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

## Referenzen

- [vMix Developer API Documentation](https://www.vmix.com/help28/DeveloperAPI.html)
- [vMix TCP API Documentation](https://www.vmix.com/help27/TCPAPI.html) (Alternative, nicht verwendet)
