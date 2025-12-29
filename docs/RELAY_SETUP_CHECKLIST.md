# Relay Setup Checklist

## Wichtige Hinweise für die manuelle Einrichtung

Diese Checkliste führt durch alle manuellen Schritte, die nach der Code-Implementierung noch notwendig sind.

---

## 1. Environment Variables

### Bridge Server (Electron Main Process)

Die Bridge benötigt die `RELAY_URL` Environment Variable. Standard ist `wss://relay.broadify.de`.

**Optionen:**

1. **Environment Variable setzen** (empfohlen für Production):
   ```bash
   export RELAY_URL=wss://relay.broadify.de
   ```

2. **In `.env` Datei** (für Development):
   ```
   RELAY_URL=wss://relay.broadify.de
   ```

3. **Als CLI Argument** (wird bereits unterstützt):
   ```bash
   --relay-url wss://relay.broadify.de
   ```

**Wichtig:** Die Bridge verwendet automatisch den Default `wss://relay.broadify.de`, wenn keine Variable gesetzt ist. Für lokales Testing kannst du auch `ws://localhost:8080` verwenden.

---

## 2. Bridge ID Management

### Automatische Generierung

Die Bridge ID wird **automatisch** beim ersten Start generiert und in `userData/bridge-id.json` gespeichert.

**Speicherort:**
- **macOS**: `~/Library/Application Support/electron-vite-template/bridge-id.json`
- **Windows**: `%APPDATA%/electron-vite-template/bridge-id.json`
- **Linux**: `~/.config/electron-vite-template/bridge-id.json`

### Manuelle Bridge ID Reset

Falls du eine neue Bridge ID benötigst:

1. Stoppe die Bridge
2. Lösche die Datei `bridge-id.json` im userData-Verzeichnis
3. Starte die Bridge neu → neue UUID wird generiert

**Oder programmatisch:**
```typescript
import { bridgeIdentity } from "./services/bridge-identity.js";
bridgeIdentity.resetBridgeId(); // Generiert neue UUID
```

---

## 3. Relay Server Setup (Fly.io)

### Deployment Checklist

1. **Fly.io App erstellen:**
   ```bash
   fly apps create relay-broadify
   ```

2. **Fly.io Secrets setzen** (falls benötigt):
   ```bash
   fly secrets set RELAY_PORT=8080
   ```

3. **Deployment:**
   ```bash
   fly deploy
   ```

### Relay Server Requirements

Der Relay Server muss folgende Endpoints unterstützen:

1. **WebSocket Endpoint** (`wss://relay.broadify.de`):
   - Empfängt `bridge_hello` Messages
   - Sendet `command` Messages
   - Empfängt `command_result` Messages

2. **HTTP Endpoint** (`POST /relay/command`):
   - Empfängt Commands von Web-App
   - Leitet an Bridge weiter (via WebSocket)
   - Wartet auf Result und sendet zurück

### Message Protocol

**Bridge → Relay:**
```json
{
  "type": "bridge_hello",
  "bridgeId": "uuid-here",
  "version": "0.1.0"
}
```

**Relay → Bridge:**
```json
{
  "type": "command",
  "requestId": "unique-request-id",
  "command": "get_status",
  "payload": {}
}
```

**Bridge → Relay:**
```json
{
  "type": "command_result",
  "requestId": "unique-request-id",
  "success": true,
  "data": { ... }
}
```

---

## 4. Testing & Debugging

### Lokales Testing

1. **Relay Server lokal starten:**
   ```bash
   # Im Relay Server Repo
   npm run dev
   # Läuft auf ws://localhost:8080
   ```

2. **Bridge mit lokalem Relay verbinden:**
   ```bash
   # In Electron App
   export RELAY_URL=ws://localhost:8080
   npm run dev
   ```

3. **Bridge Status prüfen:**
   ```bash
   curl http://localhost:8787/relay/status
   ```

   Erwartete Response:
   ```json
   {
     "connected": true,
     "bridgeId": "uuid-here",
     "lastSeen": "2024-01-01T12:00:00.000Z"
   }
   ```

### Debugging

**Bridge Logs prüfen:**
- Bridge Server Logs: Console Output (Development) oder `userData/bridge-process.log` (Production)
- Suche nach `[Relay]` Log-Einträgen

**Relay Client Status:**
- `GET http://localhost:8787/relay/status` zeigt Verbindungsstatus
- `connected: false` bedeutet, dass Relay nicht erreichbar ist oder `bridgeId`/`relayUrl` nicht gesetzt sind

**Häufige Probleme:**

1. **Relay Client startet nicht:**
   - Prüfe ob `bridgeId` und `relayUrl` in Bridge Config gesetzt sind
   - Prüfe Bridge Server Logs für Fehler

2. **Relay Verbindung schlägt fehl:**
   - Prüfe ob Relay Server läuft
   - Prüfe `RELAY_URL` Environment Variable
   - Prüfe Firewall/Network Settings

3. **Commands kommen nicht an:**
   - Prüfe ob Bridge `bridge_hello` gesendet hat
   - Prüfe Relay Server Logs
   - Prüfe ob `bridgeId` korrekt registriert ist

---

## 5. Production Deployment

### Electron App Build

1. **Bridge wird automatisch gebundelt** in `resources/bridge/`
2. **Bridge ID wird beim ersten Start generiert** (pro Installation)
3. **Relay URL** sollte als Environment Variable gesetzt werden

### Bridge ID Sharing

**Wichtig:** Die Bridge ID ist **pro Installation** eindeutig. Wenn ein User die App neu installiert, bekommt er eine neue Bridge ID.

**Für Multi-Device Support später:**
- Bridge IDs müssen in Supabase gespeichert werden
- User kann mehrere Bridges verwalten
- Bridge Registry im Relay Server (optional für MVP)

---

## 6. Was funktioniert bereits?

✅ **Bridge Identity** - Automatische UUID-Generierung  
✅ **Relay Client** - Outbound WebSocket-Verbindung  
✅ **Command Router** - Zentrale Command-Verarbeitung  
✅ **Auto-Reconnect** - Exponential Backoff  
✅ **Relay Status Endpoint** - `/relay/status`  
✅ **Health Check Integration** - Relay Status wird gepollt  
✅ **Electron Main Integration** - Bridge ID wird geladen und übergeben  

---

## 7. Was muss noch implementiert werden?

### Relay Server (separates Projekt)

- [ ] WebSocket Server für Bridge-Verbindungen
- [ ] HTTP Endpoint `/relay/command` für Web-App
- [ ] Bridge Registry (optional für MVP)
- [ ] Request/Response Matching (`requestId`)
- [ ] Timeout Handling (10s default)

### Web-App Integration (siehe `WEB_APP_RELAY_INTEGRATION.md`)

- [ ] API Route `/api/bridges/[bridgeId]/command`
- [ ] Bridge ID Eingabe statt IP/Port
- [ ] Relay-Verbindungstest
- [ ] Entfernen von Tunnel-bezogenen UI-Elementen

---

## 8. Wichtige Konfigurationen

### Default Values

- **Relay URL**: `wss://relay.broadify.de` (kann via `RELAY_URL` env var überschrieben werden)
- **Bridge ID**: Wird automatisch generiert (UUID v4)
- **Reconnect Delay**: Startet bei 1s, max 60s (Exponential Backoff)
- **Command Timeout**: 10s (im Relay Server zu implementieren)

### Environment Variables

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `RELAY_URL` | `wss://relay.broadify.de` | Relay Server WebSocket URL |
| `BRIDGE_ID` | (auto-generated) | Bridge UUID (optional, wird automatisch generiert) |

---

## 9. Nächste Schritte

1. ✅ Code-Implementierung (abgeschlossen)
2. ⏳ Relay Server auf Fly.io deployen
3. ⏳ Web-App API Routes implementieren
4. ⏳ Testing: End-to-End Command Flow
5. ⏳ Production Deployment

---

## Support & Troubleshooting

Bei Problemen:

1. Prüfe Bridge Server Logs (`[Relay]` Einträge)
2. Prüfe Relay Status: `GET /relay/status`
3. Prüfe Bridge ID: `userData/bridge-id.json`
4. Prüfe Relay URL: Environment Variable oder Default

**Bridge ID anzeigen:**
- Im UI: Bridge Status zeigt `bridgeId` wenn Relay verbunden ist
- Via API: `GET /relay/status` gibt `bridgeId` zurück

