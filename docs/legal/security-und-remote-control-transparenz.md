# Security- und Remote-Control-Transparenz (Kundeninformation)

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Dieses Dokument ist ein Transparenz- und Security-Informationsblatt. Es ersetzt keine EULA, keinen AVV und keine Datenschutzerklaerung.

## 1. Warum dieses Dokument existiert

Broadify Bridge ist eine installierbare Desktop-Software mit lokaler Bridge-Komponente und optionaler Remote-Steuerung ueber WebApp + Relay. Dadurch entstehen andere Risiken und Pflichten als bei einer reinen Website oder SaaS-Weboberflaeche.

Dieses Dokument beschreibt:

- wie die Fernsteuerung technisch funktioniert (auf hoher Ebene),
- welche Daten-/Befehlskategorien betroffen sind,
- welche Sicherheitsmassnahmen implementiert sind,
- welche Restrisiken bestehen,
- welche Sicherheitsmassnahmen Kunden selbst umsetzen muessen.

Ergaenzend sollte ein technischer Anhang gepflegt werden, der Verbindungsmechanismen, Systemabfragen und lokale Speicherung versioniert dokumentiert.

## 2. Architektur auf hoher Ebene

Kurzform:

1. Auf dem Kundenrechner laeuft die Broadify Desktop App.
2. Die Desktop App startet eine lokale Bridge (lokaler Service).
3. Die Bridge kann lokal Systeme/Geraete ansprechen (je nach Konfiguration).
4. Fuer Remote-Steuerung verbindet sich die Bridge ausgehend mit einem Relay-Dienst.
5. Die Broadify WebApp sendet Kommandos ueber Backend/Relay an die Bridge.

Hinweis zum aktuellen Implementierungsstand:

- Neben dem Remote-Pfad existieren lokale Kommunikationspfade (Bridge HTTP/WS, Electron IPC, lokales TCP-IPC fuer Graphics, Shared-Memory-FrameBus).
- Die Software liest system- und hardwarebezogene Informationen zur Geraeteerkennung/Konfiguration aus.

## 3. Was die Software technisch kann (Funktionskategorien)

Die Software kann - je nach gebuchten Funktionen und Konfiguration - insbesondere:

- lokale Statusinformationen anzeigen und verarbeiten,
- lokale Geraete/Outputs erkennen und konfigurieren,
- Engine-/Steuerkommandos an angebundene Systeme senden,
- Graphics-/Template-Payloads an den lokalen Render-/Output-Pfad uebergeben,
- Status- und Eventdaten an die WebApp zurueckmelden,
- Remote-Kommandos aus der WebApp ueber den Relay-Pfad empfangen.

Zusaetzlich kann die Software (plattform-/funktionsabhaengig):

- lokale Netzwerkinterfaces und Ports fuer Konfiguration/Diagnose pruefen,
- Display-/USB-/Capture-/DeckLink-Metadaten auslesen,
- lokale Hilfsprozesse und native Komponenten fuer Detection/Output starten,
- lokale Logs, Konfigurationen, Identifikatoren und Security-Dateien speichern.

Wichtig: Sie muessen nicht jede interne technische Einzeloperation kennen. Entscheidend ist, dass die Kategorien von Zugriffen und Datenfluesse transparent sind.

## 4. Remote-Steuerung: Was das konkret bedeutet

Wenn Remote-Steuerung aktiv genutzt wird, koennen ueber die Broadify WebApp Befehle an die lokal laufende Bridge uebermittelt werden. Diese Befehle koennen Funktionen ausloesen, die lokale Systeme, Konfigurationen oder Ausgaben beeinflussen.

Das bedeutet insbesondere:

- ein kompromittierter Nutzeraccount kann missbraeuchliche Befehle ausloesen,
- Fehlkonfigurationen koennen unerwuenschte Aktionen verursachen,
- uebermittelte Inhaltsdaten (z. B. Graphics-Werte) koennen personenbezogene Daten enthalten.

## 5. Sicherheitsmassnahmen (aktueller Stand, hoch verdichtet)

Nach aktuellem technischen Stand sind u. a. folgende Schutzmechanismen vorgesehen/implementiert:

### 5.1 Schutz im Relay-Command-Pfad

- Signierte Relay->Bridge-Command-Envelopes
- Signaturpruefung auf Bridge-Seite
- Zeitliche Gueltigkeit (TTL) pro Command
- Replay-Schutz (z. B. `jti`)
- Org-/Bridge-Bindung im Relay
- Bridge-Authentisierung gegen Relay (Challenge-Response fuer enrolled Bridges)

### 5.2 Transport- und Payload-Haertung

- Payload-/Body-Limits (z. B. 2 MB in relevanten Pfaden)
- Timeouts fuer Request-/Command-Flows
- Reduzierte Logging-Payloads (keine Standard-Voll-Payload-Dumps)
- lokale Bridge-Endpunkte mit Zugriffsschutz (Loopback/Token) fuer Status, Logs, Device-/Output- und Engine-Funktionen

### 5.3 Lokale Zugriffsschutzmassnahmen

- Bridge-Endpunkte sind lokal bevorzugt nutzbar (Loopback-Default)
- kritische lokale Endpunkte nur lokal oder mit Token
- interne IPC-Pfade fuer Graphics-Komponenten lokal (`127.0.0.1`) + Token-Handshake + Payload-Limits
- Trennung von Graphics-Control-Plane (IPC) und Data-Plane (FrameBus / Shared Memory)

### 5.4 Validierung und Sanitizing

- Zod-Validierung fuer Command-Payloads
- Sanitizing fuer Graphics-/Template-Inhalte (z. B. Blockade unsicherer HTML/CSS-Muster)

## 6. Restrisiken (ehrliche Einordnung)

Trotz Schutzmassnahmen verbleiben Restrisiken. Dazu gehoeren insbesondere:

- kompromittierte Nutzeraccounts (z. B. schwache Passwoerter, Phishing),
- Fehlbedienung durch berechtigte Nutzer,
- Fehlkonfiguration von Netzwerken/Geraeten/Zielsystemen,
- Ausfall oder Stoerung von Internet/Relay/Drittdiensten,
- sensitive Inhaltsdaten im legitimen Transportpfad (z. B. Graphics-Payloads),
- Fehlkonfiguration lokaler Bridge-Bindings (z. B. ungewollte LAN-Exposition),
- Missbrauch lokal/LAN erreichbarer Endpunkte bei unzureichender Token-/Netzabsicherung,
- Sicherheitsluecken in Drittgeraeten oder Kundensystemen.

## 7. Sicherheitsverantwortung des Kunden (sehr wichtig)

Kunden muessen mindestens folgende Massnahmen umsetzen:

1. Kontosicherheit
   - starke Passwoerter, Passwortmanager, MFA (falls verfuegbar)
2. Rollen/Berechtigungen
   - nur erforderliche Nutzer freischalten (Least Privilege)
3. Endgeraete-Sicherheit
   - Betriebssystem-Updates, Endpoint-Protection, gesicherte Benutzerkonten
4. Netzwerksegmentierung
   - produktive Steuergeraete nicht unnoetig exponieren
5. Prozessdisziplin
   - Freigaben fuer kritische Kommandos/Shows/Produktionen definieren
6. Incident-Meldung
   - Verdachtsfaelle unverzueglich an Broadify und intern melden

## 8. Empfehlungen fuer besonders sensible Umgebungen (Enterprise / Broadcast)

Empfohlen (teilweise produkt-/vertragsabhaengig):

- separate Operator- und Admin-Accounts
- MFA-Pflicht fuer alle steuerberechtigten Nutzer
- zusaetzliche Freigabeprozesse fuer kritische Remote-Aktionen
- dedizierte Produktionsnetze / VLANs
- Logging-/Audit-Reviews
- zeitlich begrenzte Remote-Freigaben (Just-in-Time Access), falls verfuegbar

## 9. Welche Daten ueber den Remote-Pfad laufen koennen (Kategorieebene)

Je nach Funktion koennen ueber den Relay-Pfad insbesondere laufen:

- Command-Metadaten
- Status- und Eventdaten
- Konfigurationsdaten
- Zielsystem-IP/Port (bei bestimmten Verbindungsbefehlen)
- Graphics-/Template-Payloads inklusive dynamischer Werte (potenziell personenbezogen)

Hinweis:

- Nicht alle Datenfluesse laufen ueber den Relay-Pfad. Ein Teil der Datenverarbeitung erfolgt rein lokal (Desktop-App <-> Bridge, lokale Device-Detection, lokale Graphics-/Output-Pfade, lokale Logs/Dateien).

## 9a. Verbindungsmechanismen und Systemzugriffe (explizit benennen)

Fuer rechtliche Transparenz sollten mindestens folgende Kategorien explizit genannt werden:

- lokale Electron-IPC-Kommunikation (UI <-> Main),
- lokale Bridge-HTTP-/WebSocket-Schnittstellen,
- Remote-Relay-WebSocket fuer Fernsteuerung,
- direkte Verbindungen zu kundenseitigen Zielsystemen (z. B. ATEM/vMix/TriCaster),
- lokales TCP-IPC zwischen Bridge und Graphics-Renderer,
- lokale Shared-Memory-/FrameBus-Kommunikation fuer Graphics,
- lokale Hilfsprozesse / native Komponenten (Detection/Output),
- Auslesen von Netzwerk-, System- und Hardwaremetadaten (plattformabhaengig),
- lokale Speicherung von Konfigurations-, Log-, Identitaets- und Sicherheitsdateien.

## 10. Was dieses Dokument bewusst nicht ist

Dieses Dokument ist:

- keine vollstaendige technische Spezifikation,
- keine Offenlegung von Geheimnissen/Schluesseln,
- kein PenTest-Bericht,
- keine Rechtsberatung.

## 11. Verweise

- EULA / Software-Nutzungsbedingungen
- Datenschutzerklaerung (Desktop App + Relay)
- Technischer Anhang (Verbindungsmechanismen / Systemzugriffe / lokale Speicherung)
- AVV/DPA (falls anwendbar)
- Support-/Security-Kontakt: `[SECURITY_CONTACT_EMAIL]`
