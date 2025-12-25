# Testing Device Detection Architecture

## Aktueller Status

**Erwartetes Verhalten**: Keine Geräte werden erkannt, da die Device Detection Module noch Platzhalter sind.

Die Module (`USBCaptureModule`, `DecklinkModule`) geben aktuell leere Arrays zurück, bis die tatsächliche Device Detection implementiert wird.

## Was sollte in den Logs stehen?

Nach `npm run dev` sollten folgende Logs erscheinen:

```
[Server] Device modules initialized
Bridge server listening on http://127.0.0.1:XXXX
```

## API Endpoints testen

### 1. Status Endpoint (sollte funktionieren)

```bash
curl http://127.0.0.1:XXXX/status
```

**Erwartete Antwort**:
```json
{
  "running": true,
  "version": "...",
  "uptime": ...,
  "mode": "...",
  "port": XXXX,
  "host": "127.0.0.1"
}
```

### 2. Devices Endpoint (rohes Device/Port Modell)

```bash
curl http://127.0.0.1:XXXX/devices
```

**Erwartete Antwort** (aktuell leer):
```json
[]
```

**Mit Refresh**:
```bash
curl "http://127.0.0.1:XXXX/devices?refresh=1"
```

### 3. Outputs Endpoint (UI-View)

```bash
curl http://127.0.0.1:XXXX/outputs
```

**Erwartete Antwort** (aktuell leer):
```json
{
  "output1": [],
  "output2": []
}
```

**Mit Refresh**:
```bash
curl "http://127.0.0.1:XXXX/outputs?refresh=1"
```

## Was zu testen ist

### ✅ Architektur-Tests (sollten funktionieren)

1. **Bridge startet korrekt**
   - Logs zeigen: `[Server] Device modules initialized`
   - Status Endpoint antwortet

2. **Module Registry funktioniert**
   - Module werden registriert (USB Capture + Decklink)
   - `detectAll()` gibt leere Arrays zurück (keine Fehler)

3. **Endpoints funktionieren**
   - `/devices` gibt `[]` zurück
   - `/outputs` gibt `{ output1: [], output2: [] }` zurück
   - Refresh-Parameter funktioniert (`?refresh=1`)

4. **Caching funktioniert**
   - Erster Request triggert Detection
   - Zweiter Request innerhalb 1s gibt Cache zurück
   - Refresh mit Rate Limiting funktioniert

### ⚠️ Erwartete Fehler (falls vorhanden)

- **Import-Fehler**: Falls TypeScript-Pfade falsch sind
- **Module Registry Fehler**: Falls Module nicht registriert werden
- **Route-Registrierung Fehler**: Falls Endpoints nicht erreichbar sind

## Nächste Schritte

Sobald die Architektur getestet ist, können die Device Detection Module implementiert werden:

1. **USB Capture Module** (schneller Start)
   - macOS: AVFoundation Integration
   - Windows: Media Foundation Integration
   - Linux: v4l2 Integration

2. **Decklink Module** (BMD SDK)
   - Blackmagic Desktop Video SDK Integration
   - Platform-spezifische Binaries

## Debugging

### Logs prüfen

Die Bridge sollte folgende Logs ausgeben:

```
[Server] Device modules initialized
[Devices] Returning 0 devices
[Outputs] Returning 0 output1 devices and 0 output2 connection types
```

### Module Registry prüfen

Falls Module nicht registriert werden, sollte ein Fehler in den Logs erscheinen.

### Cache prüfen

- Erster Request: `[Devices] Starting device detection`
- Zweiter Request (innerhalb 1s): `[Devices] Returning cached devices`

