# DSGVO-konformer Implementierungsplan (Bridge + Relay + WebApp)

Hinweis: Diese Datei ist keine Rechtsberatung. Sie beschreibt technische und organisatorische Massnahmen, die typischerweise fuer eine DSGVO-konforme Enterprise-Loesung erwartet werden. Eine finale Bewertung muss durch Rechtsberatung erfolgen.

## Ziel
Eine DSGVO-konforme Architektur und Betriebsweise fuer:
- Bridge (lokal beim Kunden, Hardware/Netzwerkzugriff)
- Relay (Cloud-Vermittlung)
- WebApp (Steuerung, User/Org-Management)

## Rechtsrahmen (Kurzbezug)
Relevante DSGVO-Artikel fuer diese Architektur:
- Art. 5 (Grundsaetze, Datenminimierung, Zweckbindung, Integritaet)
- Art. 25 (Privacy by Design/Default)
- Art. 28 (Auftragsverarbeitung)
- Art. 30 (Verzeichnis von Verarbeitungstaetigkeiten)
- Art. 32 (Sicherheit der Verarbeitung)
- Art. 33 (Meldung von Datenschutzverletzungen)
- Art. 44 (Drittlandtransfer)
- Art. 15-22 (Betroffenenrechte, z.B. Auskunft, Loeschung)

## Ausgangslage (technisch)
- Relay transportiert volle Payloads (z.B. HTML/CSS/Values) und Response-Daten.
- Pairing ist ein separater Command und schuetzt keine anderen Commands.
- AuthN/AuthZ auf Relay/Bridge-Ebene fehlt.
- Logging enthaelt Payloads (WebApp + Bridge).
- Bridge-Endpoints (HTTP/WS) sind lokal, aber ohne Auth.

## Dateninventar (Kategorien)
- Identifikatoren: bridgeId, orgId, requestId
- Pairing-Daten: pairingCode (kurzlebig)
- Content-Payloads: HTML/CSS, Values (potenziell personenbezogen)
- Netzwerkdaten: engine_connect ip/port
- Device-Daten: Output-Ports, Formate, Rollen
- Betriebsdaten: Status, Engine-Makros

## Zielbild (Enterprise, DSGVO-konform)
1) Remote Access ist per Default deaktiviert und lokal explizit aktivierbar.
2) Device Enrollment und starke Authentifizierung fuer Relay <-> Bridge.
3) Autorisierung auf Command-Ebene (Scopes, Org-Mapping, Rollen).
4) Datenminimierung und Logging-Redaction.
5) Auditierbarkeit (tamper-resistente Logs, Request-IDs).
6) Datenschutzfreundliche Voreinstellungen (keine Token/PII in URLs/Logs).

## Implementierungsplan

### Phase 0 - Sofortmassnahmen (0-2 Wochen)
Technisch:
- Relay-Verbindung per Default deaktivieren; nur bei lokaler Freigabe aktivieren.
- Pairing-Code nicht in URLs (kein Hash/Query). Nur lokal anzeigen/QR.
- Payload-Logging entfernen oder strikt redactionen (WebApp + Bridge).
- /logs, /ws und /engine Endpoints nur lokal oder mit Auth-Token.
- Payload-Groessenlimit und Timeouts erzwingen.
- Command-Allowlist auf Bridge (harte Ablehnung unbekannter Commands).

Organisatorisch:
- Interne Security-Policy fuer Logs und Debug-Outputs definieren.
- Incident-Response-Prozess entwerfen (Owner, SLA, Eskalation).

Akzeptanzkriterien:
- Ohne lokale Freigabe keine Relay-Commands.
- Pairing-Code taucht in keiner URL, keinem Log auf.
- Unbekannte Commands werden serverseitig geblockt.

### Phase 1 - AuthN/AuthZ Basis (2-6 Wochen)
Technisch:
- Device Enrollment: Pairing-Code wird nur fuer initiales Onboarding genutzt.
- Relay muss Bridge-ID an org_id binden (serverseitig), nur dann Commands.
- Command-Envelope signieren (exp, jti, scope, org_id, bridge_id).
- Bridge verifiziert Signatur, TTL und Replay-Schutz (jti-cache).
- Zod-Validierung fuer alle Commands (nicht nur graphics).

Organisatorisch:
- Rollenmodell definieren (Org-Admin, Operator, Read-only).
- Data Retention Policy fuer Logs und Audit festlegen.

Akzeptanzkriterien:
- Relay sendet nur signierte Commands.
- Bridge akzeptiert nur Commands mit gueltigem Scope.
- Replay-Versuche werden abgelehnt.

### Phase 2 - Enterprise Security (6-12 Wochen)
Technisch:
- mTLS Bridge <-> Relay, Zertifikatsrotation.
- Just-in-Time Remote Access mit lokaler Zustimmung.
- Fine-grained Scopes je Command (z.B. engine_connect nur Admin).
- Rate Limits pro Org/Bridge/Command.
- Datenminimierung in Responses (nur notwendige Felder).

Organisatorisch:
- DPIA/DSFA fuer hohe Risiken durchfuehren.
- Sicherheits-Audit (extern) planen.

Akzeptanzkriterien:
- Jede Remote-Session ist zeitlich begrenzt und auditierbar.
- Access-Logs enthalten Actor, Org, Command, Request-ID.

### Phase 3 - Compliance-Betrieb (laufend)
Technisch:
- DSAR-Export und Loeschung (Art. 15/17) implementieren.
- Datenresidenz-Optionen fuer Enterprise anbieten.
- Backup/Restore und Verfuegbarkeitstests (Art. 32).

Organisatorisch:
- AV-Vertraege (Art. 28) und Subprozessor-Liste pflegen.
- Verzeichnis der Verarbeitungstaetigkeiten (Art. 30) erstellen.
- Breach-Reporting Prozess (Art. 33) operationalisieren.
- Drittlandtransfer (Art. 44) mit SCCs/Transfer Impact bewerten.

Akzeptanzkriterien:
- DSARs innerhalb definierter SLA.
- Vollstaendige und aktualisierte Processing-Records.

## Technische Massnahmen (Katalog)
- Authentifizierung: mTLS + signierte Command-Envelope.
- Autorisierung: RBAC/ABAC, Org-Bridge-Mapping, Command-Allowlist.
- Datenminimierung: keine Payloads in Logs, Response-Felder minimieren.
- Netzwerk: Bridge lauscht nur lokal, LAN nur mit Token + Allowlist.
- Transport: TLS, HSTS, sichere Cipher Suites.
- Observability: strukturierte Logs, Request-IDs, Audit-Events.
- Secure Defaults: Remote Access default OFF, Pairing zeitlich begrenzt.

## Artefakte (Dokumente/Policies)
- Threat Model (Assets, Entry Points, Trust Boundaries)
- Data Flow Diagram (WebApp <-> Relay <-> Bridge)
- Data Retention Policy
- Incident Response Plan
- DPIA/DSFA
- AV-Vertrag + Subprozessorenliste
- Security Test Plan (PenTest, SAST/DAST)

## Offene Punkte (fuer finale Planung)
- Exakte Datenarten in templates/values (PII moeglich?)
- Datenresidenz-Anforderungen pro Kunde
- SLA fuer Remote Access und Incident Response
- Umfang der Audit-Logs (Payload ja/nein, Sampling)

