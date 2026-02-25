# Broadify – Formale Risikodokumentation, DPIA/DSFA und Retention-Regeln

**Stand:** 19. Februar 2026  
**Version:** 2.3  
**Owner:** Security Lead (Bridge / Relay / WebApp)  
**Review-Zyklus:** Quartalsweise sowie bei wesentlichen Architektur- oder Prozessänderungen  
**Gültig für:** Broadify Bridge V2, Relay, WebApp, Supabase, Vercel, Fly.io  
**Hinweis:** Dieses Dokument stellt eine technische und organisatorische Dokumentation dar und keine Rechtsberatung.

---

# 1. Ziel und Scope

Dieses Dokument kombiniert:

- Formale Risikodokumentation (technisch / organisatorisch)
- Datenschutz-Folgenabschätzung (DPIA/DSFA) gemäß Art. 35 DSGVO
- Verbindliche Aufbewahrungs- und Löschregeln (Retention Policy)

## Scope

- Bridge (Desktop + Bridge Runtime)
- Relay
- WebApp
- Betriebs- und Compliance-Prozesse (Security, Incident, DSAR, Retention)

---

# 1.1 Umsetzungsstand

Der aktuelle Umsetzungsstand umfasst:

- Pairing-Code wird in der Bridge lokal angezeigt; WebApp verarbeitet aktuell noch einen Legacy-URL-Flow mit Query/Hash (Refactor offen).
- Log- und Debug-Härtung ist technisch teilweise umgesetzt (Payload-Reduktion), formale interne Policy als separates Artefakt noch offen.
- Incident-Response-Prozess als belastbares, versioniertes Artefakt ist noch offen.
- Relay erzwingt Org-Bridge-Bindung fuer Nicht-Pairing-Commands, aber noch keine kryptografische Caller-Authentisierung am `POST /relay/command`-Einstieg.
- Bridge authentisiert Relay-Commands (Signatur/TTL/Replay), aber die Bridge authentisiert sich am Relay bei `bridge_hello` noch nicht kryptografisch.
- Phase-3-Standards sind in Teilen dokumentiert, aber nicht vollstaendig technisch/operativ nachgewiesen.
- Phase 2 (Enterprise-Hardening) ist geplant, jedoch noch nicht umgesetzt.

Verbindlicher Tracking-Plan fuer die Abarbeitung: `docs/security/gdpr-refactoring-tracker.md`.

---

# 2. Bewertungsmodell

## 2.1 Risikobewertungssystem

**Skalen:**

- Wahrscheinlichkeit (W): 1 (sehr niedrig) bis 5 (sehr hoch)
- Auswirkung (A): 1 (sehr niedrig) bis 5 (sehr hoch)
- Risikoscore = W × A (1–25)

## Risikoklassen

| Klasse  | Score | Bedeutung                                     |
| ------- | ----- | --------------------------------------------- |
| Niedrig | 1–6   | Akzeptabel mit Monitoring                     |
| Mittel  | 7–12  | Maßnahmen + aktives Tracking erforderlich     |
| Hoch    | 13–25 | Nicht akzeptabel ohne priorisierte Mitigation |

---

# 3. Formale Risikodokumentation

## 3.1 Asset- und Prozesskontext

- Remote Command Flow: WebApp → Relay → Bridge
- AuthN/AuthZ: Supabase Session/Org, Relay-Signatur, Bridge-Validierung
- Lokaler Zugriff: Desktop/Electron → Bridge HTTP/WS
- Drittanbieter: Supabase, Fly.io, Vercel, Sentry

---

# 3.2 Management-Übersicht (Restrisiko nach Maßnahmen)

## Risikoklassen-Definition

| Klasse  | Score | Erwartete Aktion         |
| ------- | ----- | ------------------------ |
| Niedrig | 1–6   | Akzeptieren + Monitoring |
| Mittel  | 7–12  | Steuern + Maßnahmenplan  |
| Hoch    | 13–25 | Priorisiert mitigieren   |

## Restrisiko-Ranking

| Rang | ID   | Risiko                           | Residual Score | Klasse  | Owner         |
| ---- | ---- | -------------------------------- | -------------- | ------- | ------------- |
| 1    | R-01 | Unautorisierte Remote-Commands   | 8              | Mittel  | Security Lead |
| 2    | R-02 | Bridge-Impersonation             | 8              | Mittel  | Bridge Lead   |
| 3    | R-06 | Drittlandtransfer                | 8              | Mittel  | DPO/Legal     |
| 4    | R-10 | Supply-Chain-Risiko              | 8              | Mittel  | Platform Lead |
| 5    | R-03 | Sensitive Daten in Logs          | 6              | Niedrig | Platform Lead |
| 6    | R-05 | Missbrauch mutierender Endpunkte | 6              | Niedrig | Bridge Lead   |
| 7    | R-07 | DSAR-Verzögerung                 | 6              | Niedrig | Privacy Owner |
| 8    | R-08 | Verzögerte Incident-Reaktion     | 6              | Niedrig | SecOps        |
| 9    | R-09 | Datenverlust / Restore-Fehler    | 6              | Niedrig | SRE Lead      |
| 10   | R-04 | Pairing-Leak via URL             | 4              | Niedrig | Desktop Lead  |

---

# 3.3 Detailregister (Inherent vs Residual)

| ID   | Risiko                         | Inherent (W,A,Score) | Kontrollen                                                    | Residual (W,A,Score) | Klasse  |
| ---- | ------------------------------ | -------------------- | ------------------------------------------------------------- | -------------------- | ------- |
| R-01 | Unautorisierte Remote-Commands | 4,5,20               | Client-AuthN, Org↔Bridge-Bindung, Signierte Commands, TTL/JTI | 2,4,8                | Mittel  |
| R-02 | Bridge-Impersonation           | 4,5,20               | Enrollment/mTLS, Session-Validierung, Key-Rotation            | 2,4,8                | Mittel  |
| R-03 | Log/Debug Leakage              | 4,4,16               | Redaction, keine Payload-Dumps, Sentry PII Scrubbing          | 2,3,6                | Niedrig |
| R-04 | Pairing-Leak                   | 3,4,12               | Kein URL-Exposure, TTL                                        | 1,4,4                | Niedrig |
| R-05 | Missbrauch Endpunkte           | 3,5,15               | Allowlist, Validierung, Limits                                | 2,3,6                | Niedrig |
| R-06 | Drittlandtransfer              | 3,5,15               | SCC/TIA, AVV, Subprozessorenliste                             | 2,4,8                | Mittel  |
| R-07 | DSAR-Verzögerung               | 3,4,12               | Runbooks, SLA, Tooling                                        | 2,3,6                | Niedrig |
| R-08 | Incident-Verzögerung           | 3,5,15               | SOP, 72h-Runbook, Übungen                                     | 2,3,6                | Niedrig |
| R-09 | Restore-Fehler                 | 3,5,15               | Backup-Rotation, Restore-Tests                                | 2,3,6                | Niedrig |
| R-10 | Supply-Chain                   | 3,4,12               | Vendor-Review, Least-Privilege, Patch-Management              | 2,4,8                | Mittel  |

---

# 4. DPIA / DSFA (Art. 35 DSGVO)

## 4.1 Beschreibung der Verarbeitung

**Zwecke:**

- Steuerung von Bridge-Funktionen
- Benutzer- und Organisationsverwaltung
- Sicherheits- und Audit-Logging

**Systeme:**

- WebApp (Vercel)
- Relay (Fly.io)
- Bridge (lokal beim Kunden)
- Supabase (Auth/DB)
- Sentry (Monitoring)

---

## 4.2 Datenkategorien

**Betroffene:**

- Kundenbenutzer (Admins, Operatoren)
- ggf. indirekt Dritte (bei Content-Daten)

**Datenarten:**

- Identifikatoren (`user_id`, `org_id`, `bridge_id`)
- Sicherheitsdaten (Scopes, Token-Metadaten)
- Audit-Events
- Betriebsdaten
- Template-/Content-Daten (potenziell personenbezogen)

---

## 4.3 Risikoanalyse für Betroffene

| Risiko                    | Inherent (W,A,Score) | Maßnahmen                              | Residual (W,A,Score) |
| ------------------------- | -------------------- | -------------------------------------- | -------------------- |
| Unbefugter Zugriff        | 4,5,20               | Starke AuthN/AuthZ, signierte Commands | 2,4,8                |
| Offenlegung Content-Daten | 4,4,16               | Redaction, Access-Control, Retention   | 2,4,8                |
| DSAR-Mängel               | 3,4,12               | DSAR-Tooling, SLA                      | 2,3,6                |
| Incident-Kommunikation    | 3,5,15               | Incident-SOP, Übungen                  | 2,3,6                |
| Drittlandtransfer         | 3,5,15               | SCC/TIA, technische Schutzmaßnahmen    | 2,4,8                |

---

## 4.4 Ergebnis der DPIA

- Verarbeitung ist unter getroffenen Maßnahmen vertretbar.
- Restrisiko: Mittel.
- Keine zwingende Vorabkonsultation erforderlich.
- Neubewertung bei:
  - neuen Hochrisiko-Verarbeitungen
  - signifikanten Architekturänderungen
  - sicherheitsrelevanten Vorfällen

---

# 5. Retention- und Löschregeln

## 5.1 Grundprinzipien

- Speicherung nur solange erforderlich.
- Automatische Löschung erfolgt nur, wenn dies durch interne Policy festgelegt ist.
- Legal Hold oder Incident Hold setzen Löschung aus.
- Löschung ist auditierbar zu dokumentieren.
- Für Templates/Presets besteht keine generelle DSGVO-Pflicht zur Löschung nach 12 Monaten Inaktivität; die Frist ist zweck- und vertragsbasiert festzulegen und zu dokumentieren.

---

## 5.2 Retention-Matrix

| Datenklasse            | Speicherort    | Max. Dauer                                                | Löschmethode                             |
| ---------------------- | -------------- | --------------------------------------------------------- | ---------------------------------------- |
| Pairing-Secrets        | Bridge lokal   | 10 Minuten                                                | TTL-Expiry                               |
| Session/Auth-Metadaten | Supabase/Relay | 30 Tage                                                   | TTL + Purge                              |
| Audit-Events           | Backend        | 180 Tage hot + 365 cold                                   | Archiv-Löschung                          |
| Security-Logs          | SIEM/Bridge    | 90 Tage hot                                               | Retention-Policy                         |
| Betriebslogs           | Observability  | 30 Tage                                                   | Rolling Retention                        |
| Templates/Presets      | DB             | Policy-basiert (zweck-/vertragsabhängig)                  | Soft + Hard Delete (falls Policy aktiv)  |
| Incident-Records       | SecOps-System  | 3 Jahre                                                   | Frist-Löschung                           |
| DSAR-Nachweise         | Privacy-System | 3 Jahre                                                   | Frist-Löschung                           |
| Backups                | Supabase Pro   | 7 Tage Standard-Retention (tägliche automatische Backups) | Supabase-Rotation + Ablauf der Retention |

**Hinweis zu Backups:**
Selektive Löschung ist nicht möglich. Löschwirkung tritt nach Ablauf der Backup-Retention ein. Restore-Prozesse beinhalten Re-Deletion.
Längere PITR-Retention kann optional konfiguriert werden, ist jedoch nicht Bestandteil des Supabase-Pro-Basispakets.

---

# 6. Governance

## Rollen

- Security Lead – Risikoregister
- Privacy Owner/DPO – DPIA & DSAR
- Platform/SRE – Retention & Backups
- Incident Manager – Breach-Prozess

## Nachweise

- Quartalsweiser Risk Review
- Jährliche DPIA-Review
- Monatlicher Retention-Report
- Halbjährliche Restore-Übung
- Jährliche Incident-Drill

---

# 7. Weiterentwicklung (Phase 2)

- Just-in-Time Remote Access mit lokaler Zustimmung
- Fein granularisierte Rollenmodelle
- Adaptives Rate-Limiting
- Vollständige mTLS-Zertifikatsrotation

---

# 8. Schlussbewertung

Der Datenschutz- und Sicherheitsreifegrad ist hoch und operativ belastbar.  
Das verbleibende Restrisiko liegt im Bereich mittel und wird durch kontinuierliches Monitoring, Governance-Prozesse und geplantes Phase-2-Hardening weiter reduziert.
