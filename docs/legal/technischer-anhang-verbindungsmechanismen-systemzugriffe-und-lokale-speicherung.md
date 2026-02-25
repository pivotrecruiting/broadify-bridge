# Technischer Anhang - Verbindungsmechanismen, Systemzugriffe und lokale Speicherung

Stand: 25. Februar 2026 (Codeaudit-basierter Entwurf)

Hinweis: Dieses Dokument ist ein technischer Transparenzanhang fuer EULA, Datenschutzhinweise und Security-Kommunikation. Es ist keine Rechtsberatung und keine vollstaendige technische Spezifikation.

## 1. Zweck und Abgrenzung

Dieser Anhang beschreibt auf hoher bis mittlerer Detailtiefe:

- welche Verbindungsmechanismen die Broadify Desktop App / Bridge nutzt,
- welche System-, Netzwerk- und Hardwareinformationen ausgelesen werden,
- welche lokalen Dateien und Datenarten gespeichert werden,
- welche lokalen Hilfsprozesse gestartet werden.

Wichtige Abgrenzung (aktueller Code-Stand):

- Kein direkter Zugriff auf Electron `systemPreferences` oder vergleichbare OS-Settings-APIs gefunden.
- Es bestehen jedoch umfangreiche systemnahe Abfragen (Netzwerkinterfaces, Ports, Displays, USB-/Video-Geraete), lokale Hintergrundprozesse und Hardware-/Output-Zugriffe.

## 2. Verbindungsmechanismen (Matrix)

| Kanal | Richtung | Lokal/Remote | Zweck | Typische Datenarten | Schutz / Hinweise |
| --- | --- | --- | --- | --- | --- |
| Electron Renderer <-> Electron Main (IPC via `contextBridge`) | bidirektional | lokal | UI-Steuerung der Desktop-App | Status, Befehle, Logs, Outputs, Konfigurationsdaten | Whitelist-API im Preload, Renderer ohne direkte Node-APIs |
| Electron Main -> Bridge HTTP | ausgehend (Main -> Bridge) | lokal (Loopback/LAN je Konfiguration) | Health, Status, Outputs, Logs, Engine-Befehle | Statusdaten, Konfigurationsdaten, Engine-Parameter, Log-Ausgaben | Timeouts, Bridge-Endpunkte lokal oder Token-geschuetzt |
| Lokale Clients -> Bridge HTTP | eingehend | lokal/LAN | Lokale API-Nutzung (`/status`, `/outputs`, `/engine/*`, `/config`, `/logs`, etc.) | Status, Device-/Outputdaten, Engine-Config, Logs | Loopback oder `BRIDGE_API_TOKEN` (`local-or-token`) |
| Lokale Clients -> Bridge WebSocket (`/ws`) | eingehend | lokal/LAN | Topic-basierte Statusupdates (`engine`, `video`) | Status-/Eventdaten | Loopback oder Token, Topic-Filter |
| Bridge -> Relay WebSocket | ausgehend | remote (i. d. R. `wss://`) | Remote-Steuerpfad / Event-Weiterleitung | `bridge_hello`, `bridge_event`, Command-Results | Reconnect, Signaturpruefung auf eingehenden Commands |
| Relay -> Bridge Commands (ueber WS) | eingehend zur Bridge | remote via Relay | Remote-Command-Ausfuehrung | Commands, Payloads, Meta (`orgId`, `scope`, `iat/exp`, `jti`) | Signaturen, TTL, Replay-Schutz, Scope-Pruefung |
| Bridge -> Relay JWKS Fetch | ausgehend | remote HTTPS | Laden/Rotieren von Relay-Signing-Public-Keys | JWKS/Public Keys | HTTPS-only, URL-Haertung, DNS/IP-Validierung gegen private Netze |
| Bridge -> Engine-Systeme (ATEM/vMix/TriCaster) | ausgehend | LAN/remote im Kundennetz | Steuerung externer Produktionssysteme | Ziel-IP/Port, Status-/Macrodaten, Steuersignale | Zod-Validierung der Eingaben; Risiko liegt stark in Kundenkonfiguration |
| Bridge <-> Graphics Renderer (lokales TCP-IPC) | bidirektional | lokal (`127.0.0.1`) | Control-Plane fuer Offscreen-Renderer | Render-Kommandos, Konfigurationsdaten, Fehler | Token-Handshake, Framing, Payload-Limits |
| Graphics Data Plane (FrameBus / Shared Memory) | lokal | lokal | Hochleistungs-Frame-Transport fuer Graphics | Bild-/Frame-Daten (RGBA etc.) | Data-Plane getrennt von IPC, native Addon |
| Bridge -> native Helper-Prozesse | ausgehend | lokal | Device-Detection / Output / Playback | CLI-Args, Metadaten, FrameBus-Parameter | feste lokale Binaries/Kommandos, Plattformabhaengigkeit |
| Desktop-App -> externe URLs (`openExternal`) | ausgehend (user-triggered) | remote | Oeffnen von Rechts-/Hilfeseiten im Browser | URL | nur `http*`-Pruefung; keine Domain-Allowlist im aktuellen Code |

## 3. Lokale Bridge-HTTP/WS-Schnittstellen (high-level)

Diese Schnittstellen sind im aktuellen Bridge-Code sichtbar und fuer Transparenz/Datenschutz relevant:

- `GET /status`
- `GET /devices`
- `GET /outputs`
- `POST /config`
- `POST /config/clear`
- `POST /engine/connect`
- `POST /engine/disconnect`
- `GET /engine/status`
- `GET /engine/macros`
- `POST /engine/macros/:id/run`
- `POST /engine/macros/:id/stop`
- `GET /video/status`
- `GET /relay/status`
- `GET /logs`
- `POST /logs/clear`
- `GET /ws` (WebSocket)

Hinweis:

- Diese Endpunkte sind im Produkt primaer fuer lokale Desktop-App/Bridge-Kommunikation und lokale/LAN-Integrationen gedacht.
- Kritische Endpunkte sind ueber Loopback oder Token abgesichert.

## 4. System- und Hardwareabfragen (Katalog)

## 4.1 Allgemeine System-/Netzwerkabfragen (Desktop)

Die Desktop-App liest u. a.:

- Netzwerkinterfaces und lokale IPv4-Adressen (z. B. Ethernet/Wi-Fi/Loopback)
- Port-Verfuegbarkeit durch lokale Bind-Tests
- CPU-Modell / CPU-Auslastung
- RAM-Auslastung
- Datentraegergesamtgroesse / Datentraegernutzung

Zwecke:

- Netzwerkkonfiguration,
- Portauswahl/Konflikterkennung,
- UI-Status/Monitoring,
- Diagnose.

## 4.2 Display-/Monitor-Erkennung (macOS)

Die Bridge/Display-Module koennen externe Displays erkennen und Metadaten verarbeiten, z. B.:

- Display-Name
- Verbindungstyp (HDMI / DisplayPort / Thunderbolt)
- Aufloesung
- Refresh-Rate
- Vendor-/Product-/Serial-Metadaten (soweit vom System geliefert)

Technisch erfolgt dies u. a. ueber systemeigene Tools/APIs (z. B. `system_profiler`) sowie Electron-Display-APIs im Graphics-Output-Pfad.

## 4.3 USB-/Capture-Geraete-Erkennung (plattformabhaengig)

### macOS

- USB-Geraeteerkennung ueber systemeigene Tools (z. B. `system_profiler`, `ioreg`)
- Verarbeitung von Metadaten wie Name, Hersteller, Vendor/Product IDs, Treiberhinweisen
- heuristische Ableitung von USB-C / Thunderbolt / DisplayPort-bezogenen Merkmalen

### Windows

- Erkennung ueber PowerShell / PnP-Device-Abfragen (Video-/Camera-/Media-Klassen)
- Verarbeitung von FriendlyName, InstanceId, Hersteller, Klasseninformationen
- heuristische Ableitung von Vendor/Product IDs und Verbindungstypmerkmalen

### Linux

- Scan von `/dev/video*`
- Nutzung von Video-/Device-Tools (z. B. `v4l2-ctl`, `udevadm`)
- Verarbeitung von Geraete-/Treiber-/Businformationen sowie Formaten/Aufloesungen

## 4.4 DeckLink-Hardware (macOS, native Helper)

Bei Nutzung von DeckLink-Funktionen werden lokale native Helper eingesetzt, die u. a.:

- DeckLink-Geraete auflisten,
- Display-Modi abfragen,
- Device-Change-Events (Watch) liefern,
- Playback-/Output-Funktionen fuer Graphics ausfuehren koennen.

Verarbeitete Daten umfassen typischerweise:

- Device-IDs, Device-Namen
- Port-IDs / Port-Rollen (z. B. Fill/Key/Video)
- unterstuetzte Modi / Formate / Pixel-Formate

## 4.5 Engine-/Produktionssystemverbindungen (direkte Netzkommunikation)

Die Bridge kann auf Nutzerkommando direkte Verbindungen zu Produktions-/Steuersystemen aufbauen, insbesondere:

- ATEM (protokollspezifische Netzwerkverbindung via Bibliothek)
- vMix (HTTP-API)
- TriCaster (HTTP-API)

Verarbeitete Daten umfassen:

- Ziel-IP und Ziel-Port
- Verbindungsstatus
- Macro-/Steuerdaten
- ggf. Fehler-/Timeout-Informationen

## 5. Lokale Prozesse und Hilfsprozesse

Die Software startet im aktuellen Design mehrere lokale Prozesse:

1. Desktop-App (Electron Main + UI)
2. lokale Bridge (Node/Fastify-Prozess)
3. separater Electron Graphics Renderer (Offscreen-/Aux-Renderer)
4. native DeckLink-Helper-Prozesse (je nach Funktion)
5. nativer Display-Helper (je nach Funktion)
6. plattformabhaengige Systemkommandos fuer Device-Detection (je nach OS/Funktion)

Hinweis:

- Diese Prozesse koennen parallel laufen und im Hintergrund aktiv sein, solange die Bridge/Outputs aktiv sind.

## 6. Lokale Speicherung (Matrix)

Die folgende Matrix beschreibt typische lokale Dateien/Datenbereiche nach aktuellem Code-Stand. Exakte Pfade koennen je OS/Paketierung variieren.

| Datei / Bereich | Ort (typisch) | Inhalt / Datenarten | Zweck | Sensitivitaet |
| --- | --- | --- | --- | --- |
| `bridge-id.json` | Electron `userData` | persistente Bridge-ID (UUID) | stabile Bridge-Identitaet | mittel |
| `bridge-profile.json` | Electron `userData` | Bridge-Name, `termsAcceptedAt`, `updatedAt` | Profil/Onboarding/Nachweis | mittel |
| `network-config.json` | Electron `userData` | Netzwerkkonfiguration (Bindings, Ports, Optionen) | lokale UI-/Bridge-Konfiguration | mittel |
| `logs/app.log` | Electron `userData/logs` | Desktop-App-Logs | Betrieb/Fehleranalyse | mittel (potenziell sensitiv) |
| `bridge-process.log` | Electron `userData` | Start-/Stdout-/Stderr-Logs des Bridge-Prozesses | Diagnose | mittel (potenziell sensitiv) |
| `logs/bridge.log` | Bridge `userDataDir/logs` | Bridge-/Server-/Runtime-Logs | Betrieb/Sicherheit/Fehleranalyse | mittel bis hoch |
| `security/relay-bridge-identity.json` | Bridge `userDataDir/security` | lokales Ed25519-Keypair (inkl. Private Key) + Metadaten | Relay-Bridge-Authentisierung | hoch |
| `graphics/output-config.json` | Bridge `userDataDir/graphics` | persistierte Graphics-Output-Konfiguration | Wiederherstellung/Runtime-Init | mittel |
| `graphics-assets/*` | Bridge `userDataDir/graphics-assets` | gespeicherte Graphics-Assets (z. B. Bilder) | lokales Rendering/Asset-Aufloesung | mittel bis hoch (inhaltsabhaengig) |
| `graphics-assets/assets.json` | Bridge `userDataDir/graphics-assets` | Asset-Manifest (IDs, Mimes, Pfade, Groessen) | Asset-Verwaltung | mittel |
| `userData/.env` (optional) | Electron `userData` | lokale Env-Konfiguration (falls verwendet/gespiegelt) | Runtime-Konfiguration | mittel bis hoch (inhaltabhaengig) |

Zusatzhinweise:

- Pairing-Codes werden im aktuellen Desktop-Code kurzlebig im Speicher verwaltet (TTL ca. 10 Minuten).
- Pairing-Daten werden fuer den Bridge-Start per ENV uebergeben (nicht per CLI-Args), um Secret-Leaks in Prozesslisten zu reduzieren.

## 7. Graphics-/Template-Datenverarbeitung (relevant fuer Datenschutz)

Bei Graphics-Funktionen werden - je nach Nutzung - verarbeitet:

- HTML-/CSS-Templates
- Schema-/Default-Werte
- dynamische Werte (`values`) mit moeglichem Personenbezug
- Asset-Dateien (z. B. Bilder) und Asset-Metadaten

Sicherheitsrelevante Punkte:

- Template-Sanitizing blockiert unsichere HTML/CSS-Muster
- externe URLs in Templates werden blockiert
- Asset-Referenzen laufen ueber lokales `asset://`-Schema
- Asset-Speicherung ist groessenbegrenzt (pro Asset / gesamt)

## 8. Fehlertracking / Monitoring (Desktop)

Im aktuellen Code-Stand ist Error-Tracking fuer die Electron-Desktop-App initialisiert (Main- und Renderer-Prozess).

Das sollte in Datenschutz- und Transparenztexten explizit erwaehnt werden, inkl.:

- Zweck (Fehleranalyse/Stabilitaet),
- Datenkategorien (technischer Fehlerkontext),
- Anbieter,
- Rechtsgrundlage / Einwilligungskonzept (falls erforderlich),
- PII-Scrubbing/Redaction-Strategie.

## 9. Was in den Rechtstexten mindestens genannt werden sollte (Praxis-Check)

### EULA / Software-Nutzungsbedingungen

- lokale Bridge als Hintergrundprozess
- lokale/LAN/Internet-Kommunikation
- Remote-Steuerung ueber Relay
- direkte Verbindungen zu kundenseitigen Systemen/Geraeten
- lokale Hilfsprozesse und native Komponenten
- Nutzerpflichten fuer Kontosicherheit, Netzwerk- und Geraeteabsicherung

### Datenschutzhinweise (App/Relay)

- Verbindungsmechanismen (Kategorieebene)
- System-/Hardwaremetadaten (Netzwerk, Displays, USB-/Capture, Engine-Ziele)
- lokale Speicherung (inkl. Schluesselmaterial-Kategorie)
- Logs / Fehlertracking / Sentry
- Graphics-Inhaltsdaten und potenzieller Personenbezug

### Security-/Remote-Transparenz

- Remote-Command-Pfad und Sicherheitsmechanismen
- lokale Schutzgrenzen (Loopback/Token, IPC-Token, Limits)
- Restrisiken (Account-Kompromittierung, Fehlbedienung, Drittgeraete)
- Kundenpflichten (MFA, Rollenmodell, Segmentierung, Incident-Meldung)
