# Broadify DSGVO/GDPR-Bewertung (Annahme: Phase 0/1 + Betrieb Phase 3 umgesetzt)

Stand: 19. Februar 2026

Hinweis: Diese Bewertung ist eine technische und organisatorische Einschaetzung, keine Rechtsberatung.

## Ziel
Diese Datei bewertet den DSGVO/GDPR-Reifegrad unter der Annahme, dass:
- die bereits umgesetzten Security-Massnahmen weiterhin wirksam sind,
- die nachfolgend genannten offenen To-dos vollstaendig umgesetzt wurden,
- die Standardpunkte aus Phase 3 im laufenden Betrieb etabliert wurden,
- Phase 2 derzeit bewusst noch nicht umgesetzt ist (nur geplant).

## Annahmen zur Umsetzung

### A) Bereits abgearbeitete Kernpunkte (bereits im Code-/Dokustand)
- [x] Signierte Relay->Bridge Command-Envelope (`meta`, `signature`, `scope`, `iat/exp`, `jti`).
- [x] Bridge-seitige Verifikation von Signatur, TTL und Replay-Schutz.
- [x] Org-Bridge-Mapping im Relay als Grundkontrolle vorhanden.
- [x] Command-Allowlist auf Bridge aktiv.
- [x] Payload-Logging in WebApp/Bridge auf Summaries reduziert.
- [x] Body/Payload-Limits und Timeouts aktiv.

### B) Neu als umgesetzt angenommen (deine To-do-Liste)
- [x] Pairing-Code nicht in URLs (kein Hash/Query), nur lokal anzeigen oder per QR.
- [x] Interne Security-Policy fuer Logs und Debug-Outputs definiert.
- [x] Incident-Response-Prozess mit Owner, SLA und Eskalationswegen eingefuehrt.
- [x] Relay bindet `bridge_id` an `org_id` und authentisiert aufrufende Clients kryptografisch; nur dann Command-Zulassung.
- [x] Bridge authentisiert sich gegen Relay (z. B. Enrollment Secret oder mTLS bei `bridge_hello`).

### C) Standardpunkte im Betrieb (Phase 3) als umgesetzt angenommen
- [x] DSAR-Prozesse (Auskunft/Export/Loeschung) technisch und organisatorisch verankert.
- [x] Datenresidenz-Optionen fuer Enterprise vorhanden.
- [x] Backup/Restore- und Verfuegbarkeitstests regelmaessig nachweisbar.
- [x] AV-Vertraege und Subprozessorenliste gepflegt.
- [x] Verzeichnis von Verarbeitungstaetigkeiten aktuell.
- [x] Breach-Reporting-Prozess (Art. 33) operationalisiert.
- [x] Drittlandtransfer mit SCC/Transfer-Impact-Bewertung dokumentiert.

## Phase-Status (bewusst)
- Phase 0: umgesetzt
- Phase 1: umgesetzt
- Phase 2: geplant, aber noch nicht umgesetzt
- Phase 3: im Betrieb umgesetzt

## Sicherheits- und Zugriffsanalyse (auf Annahme-Basis)

## 1. Zugriff und Fremdzugriff
- Remote-Commands sind nur nach starker Client-Authentisierung am Relay zulaessig.
- Bridge-Impersonation ist durch Bridge-Authentisierung am `bridge_hello`-Pfad erheblich reduziert.
- Org-Bindung + kryptografische AuthN am Entry verhindert unautorisierte Fremdzugriffe deutlich besser als im Ausgangszustand.

## 2. Vertraulichkeit und Logging
- Kein Pairing-Secret in URLs reduziert Leaks ueber Browser-Historie, Screenshots und Link-Sharing.
- Logging-Policy minimiert unbeabsichtigte Offenlegung von Payloads/PII in Debug- und Betriebslogs.

## 3. Integritaet und Nachvollziehbarkeit
- Signierte Commands + Replay-Schutz + Incident-Prozess schaffen hohe technische und organisatorische Nachvollziehbarkeit.
- Mit laufendem Breach- und Audit-Betrieb sind Melde- und Reaktionsketten belastbar.

## 4. Verfuegbarkeit und Betrieb
- Regelmaessige Backup/Restore-Tests und definierte SLA erhoehen Betriebssicherheit und Incident-Resilienz.
- Phase-3-Standards staerken den Nachweis einer dauerhaft kontrollierten Verarbeitung.

## DSGVO/GDPR-Bewertung (unter den obigen Annahmen)

| Bereich | Bewertung |
| --- | --- |
| Art. 5 (Grundsaetze) | weitgehend erfuellt |
| Art. 25 (Privacy by Design/Default) | weitgehend erfuellt |
| Art. 28 (Auftragsverarbeitung) | erfuellt, sofern AVV/Subprozessoren aktuell gehalten werden |
| Art. 30 (Verzeichnis) | erfuellt, bei laufender Pflege |
| Art. 32 (Sicherheit der Verarbeitung) | weitgehend erfuellt |
| Art. 33 (Breach-Meldung) | erfuellt, wenn Prozess geuebt und dokumentiert ist |
| Art. 44 (Drittlandtransfer) | erfuellt unter SCC/TIA-Nachweis |
| Art. 15-22 (Betroffenenrechte) | weitgehend erfuellt bei funktionierenden DSAR-Ablaeufen |

## Gesamtbewertung
- Ergebnis: **hoher DSGVO-Compliance-Reifegrad** im angenommenen Zustand.
- Einordnung: **"weitgehend DSGVO-konform und auditfaehig"**, mit verbleibendem Optimierungspotenzial.
- Score (technisch-organisatorisch): **ca. 85/100**.

## Restrisiko und klare Abgrenzung
- Da Phase 2 noch nicht umgesetzt ist, fehlen typischerweise noch Enterprise-Hardening-Massnahmen wie:
  - durchgaengiges mTLS-Zertifikatsmanagement mit Rotation,
  - Just-in-Time Remote Access mit lokaler Zustimmung je Session,
  - feinere Command-Scopes/Rollen pro Aktion,
  - tiefergehende Rate-Limits pro Org/Bridge/Command.
- Folge: Gute Compliance-Basis ist vorhanden, aber das maximale Sicherheitsniveau fuer besonders kritische Hochrisiko-Szenarien wird erst mit Phase 2 erreicht.

## Fazit
Unter der angenommenen Umsetzung von Phase 0/1, den zusaetzlichen To-do-Punkten und den betrieblichen Phase-3-Standards ist Broadify aus technischer und organisatorischer Sicht klar naeher an einem belastbaren DSGVO-konformen Zielbild. Phase 2 bleibt als geplanter Ausbaupfad bestehen und sollte als naechster Security-Reifegrad priorisiert werden.
