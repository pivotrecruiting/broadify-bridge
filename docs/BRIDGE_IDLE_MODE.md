# Bridge Idle Mode - Outputs Konfiguration

## Übersicht

Die Bridge startet **immer im "Idle" Mode** ohne Outputs. Outputs können später über die API konfiguriert werden.

## Bridge Start

Die Bridge startet **ohne Outputs** und läuft im Discovery-Mode:

- ✅ Bridge startet sofort (nur Port-Konfiguration erforderlich)
- ✅ `/status`, `/devices`, `/outputs` Endpoints sind sofort verfügbar
- ✅ Outputs werden später via `POST /config` konfiguriert

## Status Endpoint

**GET** `/status`

Zeigt den aktuellen Bridge-Status:

```json
{
  "running": true,
  "version": "0.1.0",
  "uptime": 22,
  "mode": "local",
  "port": 8787,
  "host": "127.0.0.1",
  "state": "idle",
  "outputsConfigured": false
}
```

**State-Werte**:
- `idle`: Bridge läuft, keine Outputs konfiguriert
- `configured`: Outputs konfiguriert, aber noch nicht aktiv
- `active`: Outputs konfiguriert und aktiv (Controller geöffnet)

## Outputs abfragen

**GET** `/outputs`

Gibt verfügbare Output-Geräte zurück (UI-Format):

```json
{
  "output1": [
    {
      "id": "device-id-1",
      "name": "Decklink Card 1",
      "type": "decklink",
      "available": true
    }
  ],
  "output2": [
    {
      "id": "sdi",
      "name": "SDI",
      "type": "connection",
      "available": true
    }
  ]
}
```

**GET** `/devices`

Gibt rohes Device/Port Modell zurück (erweiterte Informationen):

```json
[
  {
    "id": "device-id-1",
    "displayName": "Decklink Card 1",
    "type": "decklink",
    "ports": [
      {
        "id": "device-id-1-port-0",
        "displayName": "SDI-A",
        "type": "sdi",
        "direction": "output",
        "capabilities": {
          "formats": ["1080p50", "1080p60"]
        },
        "status": {
          "available": true
        }
      }
    ],
    "status": {
      "present": true,
      "inUse": false,
      "ready": true,
      "lastSeen": 1234567890
    }
  }
]
```

## Outputs konfigurieren

**POST** `/config`

Konfiguriert Outputs und/oder Engine:

**Request Body**:
```json
{
  "outputs": {
    "output1": "device-id-1",
    "output2": "sdi"
  },
  "engine": {
    "type": "atem",
    "ip": "192.168.1.100",
    "port": 9910
  }
}
```

**Response**:
```json
{
  "success": true,
  "state": "active",
  "outputsConfigured": true
}
```

**Validierung**:
- Output-Geräte müssen existieren und verfügbar sein
- Device Controller werden exklusiv geöffnet
- Bridge State wird auf `active` gesetzt

**Fehler-Behandlung**:
- `400`: Ungültige Outputs (Gerät nicht gefunden oder nicht verfügbar)
- `500`: Fehler beim Öffnen der Device Controller

## Konfiguration zurücksetzen

**POST** `/config/clear`

Setzt die Runtime-Konfiguration zurück:

**Response**:
```json
{
  "success": true,
  "state": "idle"
}
```

## Refresh-Parameter

**GET** `/outputs?refresh=1`  
**GET** `/devices?refresh=1`

Erzwingt eine neue Device-Detection (mit Rate Limiting):

- Rate Limit: 2 Sekunden zwischen Refreshes
- Bei zu häufigen Requests: `429 Rate Limit Exceeded`

## Beispiel-Workflow

1. **Bridge starten** (ohne Outputs)
   ```bash
   # Bridge startet automatisch im Idle-Mode
   ```

2. **Verfügbare Outputs abfragen**
   ```bash
   curl http://127.0.0.1:8787/outputs
   ```

3. **Outputs konfigurieren**
   ```bash
   curl -X POST http://127.0.0.1:8787/config \
     -H "Content-Type: application/json" \
     -d '{
       "outputs": {
         "output1": "device-id-1",
         "output2": "sdi"
       }
     }'
   ```

4. **Status prüfen**
   ```bash
   curl http://127.0.0.1:8787/status
   # Sollte jetzt state: "active" zeigen
   ```

## Vorteile

✅ **Kein Bootstrapping-Problem**: Bridge startet immer, Outputs optional  
✅ **Single Source of Truth**: Bridge ist einzige Quelle für Device Detection  
✅ **Flexible Konfiguration**: Outputs können jederzeit geändert werden  
✅ **Robust**: Keine Race Conditions, keine doppelte Implementierung

