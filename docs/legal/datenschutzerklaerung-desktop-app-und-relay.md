# Datenschutzerklaerung (Ergaenzung) - Broadify Desktop App, Bridge und Relay

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Mustertext / keine Rechtsberatung. Dieser Text ist als eigenstaendiger Abschnitt oder separate Datenschutzerklaerung fuer die installierbare Software gedacht. Website-/Marketing-/Stripe-Texte allein sind hierfuer nicht ausreichend.

## 1. Worum es in diesem Dokument geht

Diese Datenschutzhinweise beschreiben die Verarbeitung personenbezogener Daten bei der Nutzung der installierbaren Broadify Desktop App ("Broadify Bridge"), der lokal laufenden Bridge-Komponente und der damit verbundenen Remote-Steuerung ueber die Broadify WebApp und den Relay-Dienst.

Dieses Dokument ergaenzt die Datenschutzhinweise fuer:

- Website (Marketing, Cookies, Kontaktformulare),
- WebApp (Account, Login, Subscription, Organisationsverwaltung),
- Zahlungsabwicklung (z. B. Stripe).

## 2. Verantwortlicher / Kontakt

Verantwortlicher (Art. 4 Nr. 7 DSGVO):

- `[LEGAL_ENTITY_NAME]`
- `[ADDRESS]`
- `[EMAIL_PRIVACY]`

Datenschutzkontakt / DSB (falls vorhanden):

- `[DPO_CONTACT]`

## 3. Rollenmodell (wichtig fuer B2B)

Je nach Nutzung kann Broadify datenschutzrechtlich unterschiedliche Rollen einnehmen:

1. Verantwortlicher
   - fuer Account-, Lizenz-, Abrechnungs- und Sicherheitsprozesse rund um die Broadify-Dienste.

2. Auftragsverarbeiter (typisch bei B2B-Produktivnutzung)
   - soweit ueber die Software/Relay im Auftrag des Kunden personenbezogene Inhalts- oder Betriebsdaten verarbeitet werden.

3. Getrennte Verantwortlichkeit / gemeinsame Verantwortlichkeit
   - kann in Einzelfaellen fuer bestimmte Integrationen oder Supportprozesse relevant sein.

Die konkrete Rollenverteilung ist vertraglich (inkl. AVV/DPA, falls erforderlich) festzulegen.

## 4. Welche Funktionen der Software datenschutzrelevant sind

Die Desktop-App/Bridge kann insbesondere:

- lokal eine Bridge-Komponente starten und betreiben,
- lokale Hilfsprozesse / native Komponenten fuer Geraeteerkennung, Rendering und Ausgabe starten (plattform- und funktionsabhaengig),
- mit der Broadify WebApp und dem Relay-Dienst kommunizieren,
- Steuerungsbefehle remote empfangen und ausfuehren,
- lokale Geraete-/Output-Informationen erfassen und zur Anzeige/Steuerung bereitstellen,
- system- und netzwerkbezogene Informationen (z. B. Interfaces, IPs, Port-Verfuegbarkeit) zur Konfiguration und Diagnose verarbeiten,
- technische Systemressourcen-/Diagnosedaten (z. B. CPU/RAM/Datentraegermetriken) fuer UI/Monitoring verarbeiten,
- Konfigurationen, Identifikatoren und Logs lokal speichern,
- Fehler- und Absturzinformationen an einen Monitoring-/Error-Tracking-Dienst uebermitteln (sofern aktiviert).

## 5. Kategorien verarbeiteter Daten

Die folgenden Kategorien sind aus aktuellem Architektur-/Code-Stand abzuleiten. Je nach Plan/Funktion kann nicht jede Kategorie in jedem Fall anfallen.

### 5.1 Account-, Organisations- und Lizenzdaten (vor allem WebApp/Backend)

- Benutzerkonto-/Login-Daten
- Rollen-/Berechtigungsinformationen
- Organisationszuordnungen
- Lizenz-/Subscription-Status

### 5.2 Geraete- und Bridge-Identifikatoren

- `bridge_id` (UUID)
- Bridge-Name (nutzerdefiniert)
- technische Versions-/Runtime-Informationen
- ggf. Geraete-/Output-IDs und Bezeichnungen

### 5.3 Netzwerk- und Verbindungsdaten

- IP-Adressen (Client, Bridge, Zielgeraete je nach Funktion)
- Ports (z. B. Engine-Verbindungen)
- Zeitstempel, Request-/Command-IDs
- Relay-Verbindungsstatus
- Netzwerkinterface-Informationen (z. B. Interface-Namen, lokale IPv4-Adressen)
- Port-Pruef-/Verfuegbarkeitsinformationen

### 5.3a Verbindungs- und Transportmetadaten (technisch)

- Metadaten aus lokalen HTTP-/WebSocket-Kommunikationspfaden der Bridge
- Metadaten aus Remote-Relay-WebSocket-Verbindungen
- lokale IPC-Metadaten zwischen Bridge und Graphics-Renderer (z. B. Ports, technische Sitzungsparameter)
- Frame-/Output-Session-Metadaten (z. B. FrameBus-Name, technische Formatparameter)

### 5.4 Steuerungs-, Status- und Konfigurationsdaten

- Command-Metadaten (z. B. Command-Typ, Zeitfenster/TTL, Scope-Metadaten)
- Statusdaten (z. B. Outputs, Engine-Status, Verbindungsstatus)
- Konfigurationsdaten fuer lokale Bridge-/Netzwerkeinstellungen
- Engine-Zielparameter (z. B. Ziel-IP und Ziel-Port fuer ATEM/vMix/TriCaster)

### 5.5 Inhaltsdaten (potenziell personenbezogen)

Je nach Nutzung koennen ueber Graphics-/Template-Funktionen Inhaltsdaten verarbeitet werden, z. B.:

- Template-Inhalte (HTML/CSS-Bundles)
- dynamische Werte (`values`), die personenbezogene Daten enthalten koennen
- Asset-Metadaten
- lokal gespeicherte Graphics-Assets (z. B. Bilddateien), soweit ueber die Software bereitgestellt

### 5.6 Pairing- und Sicherheitsdaten

- Pairing-Code (kurzlebig)
- Sicherheitsmetadaten (z. B. Signatur-/Replay-/TTL-Metadaten)
- Enrollment-/Schluessel-Metadaten fuer Bridge-Authentisierung

### 5.7 Protokoll-, Fehler- und Diagnosedaten

- lokale App-/Bridge-Logs
- Fehler- und Absturzmeldungen
- technische Kontextdaten fuer Troubleshooting
- Error-Tracking-/Crash-Kontext aus der Electron-Desktop-App (Main und Renderer), soweit aktiviert

## 6. Zwecke und Rechtsgrundlagen (muss final abgestimmt werden)

### 6.1 Bereitstellung und Betrieb der Software / Remote-Steuerung

Zweck:

- Bereitstellung der vereinbarten Softwarefunktionen,
- Aufbau und Betrieb der Remote-Steuerung (WebApp -> Relay -> Bridge),
- Ausfuehrung und Rueckmeldung von Steuerungsbefehlen.

Rechtsgrundlage (typisch):

- Art. 6 Abs. 1 lit. b DSGVO (Vertragserfuellung)
- ggf. Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an sicherem, funktionsfaehigem Betrieb)

### 6.2 IT-Sicherheit, Missbrauchserkennung und Systemschutz

Zweck:

- Authentisierung/Autorisierung,
- Replay-/Missbrauchsschutz,
- Sicherheitslogging,
- Incident-Analyse.

Rechtsgrundlage (typisch):

- Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Sicherheit und Missbrauchsverhinderung)
- ggf. Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Pflichten, z. B. Nachweis-/Meldepflichten)

### 6.3 Fehleranalyse / Stabilitaet / Monitoring

Zweck:

- Analyse von Abstuerzen und Fehlern,
- Stabilisierung der Desktop-App/Bridge,
- Verbesserung der Produktqualitaet.

Rechtsgrundlage (typisch):

- Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse)
- alternativ/erganzend Einwilligung, falls national erforderlich oder intern so entschieden

Hinweis: Wenn ein externer Fehlertracking-Dienst (z. B. Sentry) genutzt wird, sind Datenumfang, PII-Scrubbing und Rechtsgrundlagen gesondert zu pruefen.

## 7. Datenquellen

Personenbezogene Daten stammen typischerweise aus:

- Eingaben des Nutzers in WebApp/Desktop-App,
- der lokalen Bridge-/Systemkonfiguration,
- angeschlossenen oder im Netzwerk angesprochenen Zielsystemen (Metadaten),
- Relay-/Backend-Kommunikation,
- Logs/Fehlermeldungen im Betrieb.

## 8. Empfaenger und Kategorien von Empfaengern

Je nach Architektur und Vertrag koennen Daten an folgende Empfaenger uebermittelt werden bzw. durch diese verarbeitet werden:

- interne Teams (Support, Betrieb, Security) nach Need-to-know
- Hosting-/Plattformanbieter der WebApp/Backend-/Relay-Infrastruktur
- Datenbank-/Auth-Anbieter
- Fehlertracking-/Monitoring-Anbieter
- Zahlungsanbieter (separat in Website/WebApp-Datenschutztexten)

### 8.1 Typische Drittanbieter (bitte final pruefen und vervollstaendigen)

Aus den vorhandenen Security-Dokumenten ergeben sich u. a. folgende Anbieter:

- Supabase (Auth / Datenbank / API)
- Fly.io (Relay-Hosting)
- Vercel (WebApp-Hosting)
- Sentry (Error Monitoring; Web und Electron)
- Stripe (Billing, separat in Zahlungsabschnitt)

Weitere tatsaechlich genutzte Anbieter (z. B. E-Mail, CDN, Tunnel, Support) sind aufzunehmen.

## 9. Remote-Relay-Architektur (Transparenzhinweis)

Die Software nutzt fuer Remote-Steuerung eine Relay-Architektur. Dabei koennen Steuerungsdaten, Statusdaten und je nach Funktion auch Inhaltsdaten (z. B. Graphics-/Template-Payloads) ueber den Relay-Dienst verarbeitet bzw. weitergeleitet werden.

Wichtige Punkte:

- die lokale Bridge baut eine ausgehende Verbindung zum Relay auf,
- Befehle werden ueber WebApp/Backend/Relay an die Bridge vermittelt,
- je nach Funktion koennen Inhalte personenbezogene Daten enthalten,
- die Daten koennen auf dem Transportweg durch Dienstleister verarbeitet werden,
- es gelten technische Schutzmassnahmen (u. a. Signaturen, Replay-Schutz, Limits), jedoch kein Null-Risiko.

Ergaenzend nutzt die Software weitere lokale Verbindungsmechanismen (z. B. lokale Bridge-HTTP/WS-Schnittstellen, lokale IPC-Verbindungen zwischen internen Komponenten, Shared-Memory-Transport fuer Graphics-Daten). Diese dienen der Funktion der Desktop-App und lokalen Bridge.

## 10. Lokale Speicherung auf dem Endgeraet

Die Desktop-App/Bridge speichert lokal - je nach Nutzung - insbesondere:

- Bridge-ID und Profilinformationen (z. B. Bridge-Name, Zeitstempel der AGB-Akzeptanz),
- Konfigurationsdaten (z. B. Netzwerk-/Bridge-/Graphics-Output-Konfigurationen),
- lokale Logdateien,
- sicherheitsbezogene Schluessel-/Enrollment-Daten fuer Relay-Authentisierung (inkl. lokaler Bridge-Authentisierungsidentitaet),
- ggf. lokale Assets/Template-bezogene Dateien fuer Graphics-Funktionen.

Die Speicherung erfolgt im jeweiligen App-/Bridge-Datenverzeichnis des Betriebssystems bzw. in einem konfigurierten Bridge-UserData-Verzeichnis.

Hinweis: Einzelne technische Dateinamen/-arten (z. B. Bridge-ID, Profil, Logs, Graphics-Assets/Manifeste, lokale Schluesseldateien) sollten in einer technischen Anhangsdokumentation oder internen TOM-/Data-Inventory-Dokumentation gepflegt werden.

## 11. Speicherdauer und Loeschung (mit Betriebsrealitaet abgleichen)

Die konkrete Speicherdauer haengt von Datenart, Zweck, Vertrag und Betriebsprozessen ab. Grundsaetzlich speichern wir Daten nur so lange, wie dies fuer die genannten Zwecke erforderlich ist oder gesetzliche Aufbewahrungspflichten bestehen.

Technisch dokumentierte/derzeit vorgesehene Leitwerte (final pruefen):

- Pairing-Secrets: kurzlebig (z. B. ca. 10 Minuten)
- Betriebs-/App-/Bridge-Logs: begrenzte Aufbewahrung / Rolling-Retention
- Security-/Audit-Logs: laenger zur Sicherheitsnachvollziehbarkeit
- Backups: gem. Infrastruktur-/Provider-Retention

Verbindliche Fristen sollten in einer separaten Retention-Policy gepflegt werden.

## 12. Internationale Datentransfers / Drittlandtransfer

Wenn Anbieter ausserhalb der EU/des EWR eingesetzt werden oder Zugriffe aus Drittlaendern erfolgen, kann ein Drittlandtransfer vorliegen.

In diesem Fall sind - je nach Anbieter und Datenkategorie - geeignete Garantien vorzusehen, z. B.:

- EU-Standardvertragsklauseln (SCC),
- Transfer Impact Assessment (TIA),
- zusaetzliche technische/organisatorische Massnahmen.

Bitte final die tatsaechlichen Standorte der eingesetzten Dienste dokumentieren.

## 13. Sicherheitsmassnahmen (Kurzueberblick)

Wir setzen technische und organisatorische Massnahmen ein, darunter - nach aktuellem Stand - insbesondere:

- Authentisierung/Autorisierung im Remote-Steuerpfad,
- signierte Commands und Replay-Schutz,
- Payload-/Groessenlimits und Timeouts,
- lokale Zugriffsbeschraenkungen fuer Bridge-Endpunkte (Loopback oder Token),
- Logging-Reduktion/Redaction (keine Voll-Payload-Dumps in Standardlogs),
- abgesicherte IPC-Kommunikation zwischen internen Komponenten (lokal + Token-Handshake),
- rollen- und organisationsbezogene Zugriffskontrollen in den Cloud-Komponenten.

Eine detailliertere technische Beschreibung kann in einer separaten Security-Transparenzseite und einem technischen Anhang (Verbindungsmechanismen / Systemzugriffe / lokale Speicherung) bereitgestellt werden.

## 14. Betroffenenrechte

Betroffene Personen haben - soweit anwendbar - insbesondere folgende Rechte:

- Auskunft
- Berichtigung
- Loeschung
- Einschraenkung der Verarbeitung
- Datenuebertragbarkeit
- Widerspruch
- Beschwerde bei einer Aufsichtsbehoerde

Anfragen koennen an `[EMAIL_PRIVACY]` gerichtet werden.

Bei B2B-Auftragsverarbeitung erfolgen Betroffenenanfragen teilweise ueber den jeweiligen Kunden als Verantwortlichen; vertragliche Regelungen (AVV/DPA) gehen vor.

## 15. Pflicht zur Bereitstellung / Folgen der Nichtbereitstellung

Bestimmte Daten sind technisch erforderlich, um die Software bereitzustellen und Remote-Steuerung sicher zu betreiben (z. B. Identifikatoren, Verbindungs- und Sicherheitsmetadaten). Ohne diese Daten kann die Nutzung einzelner Funktionen eingeschraenkt oder nicht moeglich sein.

## 16. Aenderungen dieser Datenschutzhinweise

Wir koennen diese Datenschutzhinweise anpassen, wenn sich Funktionen, Datenverarbeitungen, Dienstleister oder rechtliche Anforderungen aendern. Die jeweils aktuelle Fassung wird an geeigneter Stelle bereitgestellt.

## 17. Technischer Anhang (empfohlen)

Fuer eine belastbare Transparenz gegenueber Kunden und zur juristischen Abstimmung empfehlen wir einen versionierten technischen Anhang mit:

- Verbindungsmechanismen (lokal/remote, HTTP/WS/IPC/FrameBus),
- System-/Hardwareabfragen (plattformabhaengig),
- lokalen Speicherorten und Datenklassen,
- Hilfsprozessen / nativen Komponenten.

Dieser Anhang kann als separates Dokument bereitgestellt werden.

## Anhang A - Tabelle zur Finalisierung (auszufuellen)

| Feld | Platzhalter / Aktion |
| --- | --- |
| Verantwortlicher | `[LEGAL_ENTITY_NAME]`, Adresse, Kontakt |
| Datenschutzkontakt | `[DPO_CONTACT]` |
| B2B/B2C Rollenmodell | Verantwortlicher / AV / getrennt / gemischt |
| Subprozessorenliste | Anbieter, Zweck, Land, Rechtsmechanismus |
| Rechtsgrundlagen | pro Datenkategorie final pruefen |
| Retention | verbindliche Fristen und Loeschprozesse |
| Sentry-Konfiguration | PII-Scrubbing, DSN, Opt-out/Opt-in Strategie |
| Transfermechanismen | SCC/TIA/sonstige Garantien |
