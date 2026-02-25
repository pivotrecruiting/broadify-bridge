# Broadify Legal Docs (Desktop App + Relay) - Entwurfsset

Stand: 25. Februar 2026

Hinweis: Dieses Set ist ein technisch abgestimmter Entwurf und keine Rechtsberatung. Die finale Freigabe sollte durch einen IT-/Medienrechtsanwalt erfolgen.

## Zweck

Dieses Verzeichnis trennt die rechtlich relevanten Texte fuer die installierbare Broadify-Desktop-Software (Electron + lokale Bridge + Relay-Remote-Steuerung) von den bestehenden Webseiten-/WebApp-Dokumenten.

Die Entwuerfe basieren auf:

- `docs/security/customer-security-access-gdpr.md`
- `docs/security/relay-data-traffic.md`
- `docs/security/formale-risikodokumentation-dpia-retention.md`
- aktuellem Code-Stand in `src/electron/*` und `apps/bridge/src/*`

## Dokumentenmatrix (empfohlen)

1. `software-nutzungsbedingungen-eula-broadify-bridge.md`
   - Eigene Software-Nutzungsbedingungen (EULA / Software-AGB)
   - Deckt Installation, lokale Services, Remote-Steuerung, Haftung, Sicherheitspflichten ab

2. `datenschutzerklaerung-desktop-app-und-relay.md`
   - Datenschutztext fuer Desktop-App + lokale Bridge + Relay-Verarbeitung
   - Kann als eigener Abschnitt in die zentrale Datenschutzerklaerung uebernommen werden

3. `security-und-remote-control-transparenz.md`
   - Technischer Transparenztext fuer Kunden (kein Ersatz fuer EULA/Datenschutz)
   - Beschreibt Remote-Command-Architektur, Sicherheitsmechanismen, Restrisiken, Pflichten des Nutzers

4. `avv-pruefmatrix-und-pflichtenprofil.md`
   - Entscheidungshilfe, ob AVV/DPA erforderlich ist
   - Enthaelt Pflichtinhalte fuer AVV/TOMs/Subprozessoren/SCC

5. `textbausteine-download-und-onboarding.md`
   - UI-Texte fuer Download-Modal, First-Run-Onboarding und Remote-Access-Hinweise
   - Ersetzt generische Verweise auf reine Web-AGB/Datenschutz

6. `technischer-anhang-verbindungsmechanismen-systemzugriffe-und-lokale-speicherung.md`
   - Technischer Transparenzanhang mit Verbindungsmechanismen, System-/Hardwareabfragen, lokalen Dateien und Hilfsprozessen
   - Dient als SSOT fuer rechtliche Abstimmung (EULA/Datenschutz/Security-Texte)

## Wichtige technische Fakten (aus Code/Doku abgeleitet)

- Desktop-App startet lokal eine Bridge (Fastify + WebSocket).
- Default-Bind ist lokal (`127.0.0.1`), LAN-Modi sind optional konfigurierbar.
- Relay-Remote-Steuerung ist Teil des Produktmodells (WebApp -> Relay -> Bridge).
- Relay-Commands sind signiert; Bridge validiert Signatur, TTL und Replay-Schutz.
- Pairing-Code ist kurzlebig (10 Minuten) und wird lokal generiert/angezeigt.
- Lokale Logs werden gespeichert; Fehlertracking via Sentry ist im Desktop Main + Renderer initialisiert.
- Die App speichert lokale Identifikatoren/Profile (u. a. Bridge-ID, Bridge-Name, Terms-Accepted-Timestamp).
- Die Bridge nutzt mehrere Verbindungsmechanismen (lokales HTTP/WS, Relay-WSS, lokales TCP-IPC fuer Graphics, Shared-Memory FrameBus, direkte Engine-Verbindungen).
- Die Software liest system- und hardwarebezogene Informationen (z. B. Netzwerkinterfaces, Ports, Displays, USB-/Capture-Geraete) fuer Betrieb und Konfiguration.

## Offene Pflichtangaben vor produktiver Nutzung (Legal/Privacy)

Diese Platzhalter muessen vor Veroeffentlichung ausgefuellt werden:

- `[LEGAL_ENTITY_NAME]`, `[ADDRESS]`, `[EMAIL_PRIVACY]`, `[DPO_CONTACT]`
- B2B/B2C-Zielgruppe und passende Klauselvariante
- konkrete Subprozessorenliste inkl. Standorte (EU/US/weitere)
- Rechtsgrundlagen je Verarbeitung (Art. 6 DSGVO) final abstimmen
- Aufbewahrungsfristen final (Backend/Logs/Audits) mit Betrieb abgleichen
- Incident/Breach-Prozess, Support-SLA, Security-Kontakte
- Exportkontrolle / sanktionierte Nutzung (falls relevant)

## Empfohlene Rollout-Reihenfolge

1. EULA finalisieren (inkl. B2B/B2C-Variante).
2. Datenschutztext fuer App/Relay finalisieren.
3. Download-Modal und App-Onboarding-Texte auf neue Dokumente umstellen.
4. AVV/TOMs/Subprozessorenpaket vorbereiten (B2B).
5. Security-Transparenzseite veroeffentlichen und in Support/Onboarding verlinken.
