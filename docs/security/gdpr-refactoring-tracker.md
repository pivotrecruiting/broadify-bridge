# GDPR Refactoring Tracker (Bridge + Relay + WebApp)

Stand: 25. Februar 2026
Status: Arbeitsplan / Fortschrittstracking
Basis: `docs/security/gdpr-implementation-plan.md`

Hinweis: Technischer Refaktorisierungs- und Härtungsplan (keine Rechtsberatung).

## 1. Festgelegte Entscheidungen (verbindlich)

Diese Punkte sind fuer den Refactor gesetzt:

- Pairing-Token wird nur in der Bridge angezeigt (lokal), nicht ueber WebApp-Links/URL-Parameter transportiert.
- WebApp Pairing erfolgt manuell: User kopiert `bridgeId` und `pairingCode` in die WebApp.
- Bridge-Authentisierung gegen Relay erfolgt mit Bridge-Keypair (kein PSK).
- Audit-Events duerfen in Supabase gespeichert werden.
- Security-Massnahmen duerfen keine wahrnehmbare Latenz im Command-Flow verursachen.
- Read-only Bridge-Endpoints werden geschuetzt, wenn das ohne Funktionsverlust/Performance-Einbruch moeglich ist (Loopback-Betrieb darf unveraendert bleiben).

## 2. Best-Practice Entscheidungen (Aufwand/Reward, latenzneutral)

### 2.1 Relay Caller Auth (WebApp -> Relay) ohne zusaetzliche Latenz

Empfehlung (bestes Aufwand/Reward-Verhaeltnis, latenzneutral):

- Kurzlebige signierte Client-Assertion (JWT oder kompaktes Ed25519-signiertes JSON) von der WebApp-Server-Route an den Relay.
- Relay verifiziert die Signatur lokal (offline, ohne zusaetzlichen Netzwerk-Call).
- Relay verwendet nur Claims aus der verifizierten Assertion fuer `org_id`, `actor_user_id`, `role`, `bridge_id`, `command`.
- `payload_hash`, `iat/exp`, `jti` (Replay-Schutz) in der Assertion erzwingen.

Warum:

- Kein zusaetzlicher Roundtrip (nur lokale Signaturpruefung im Relay).
- Deutlich besser als heute, wo `POST /relay/command` den Caller nicht kryptografisch authentisiert.
- Einfacher einzufuehren als sofortiges mTLS zwischen WebApp und Relay.

Nicht empfohlen fuer Phase 1:

- Per-Request Token-Introspection gegen Supabase im Relay fuer `/relay/command` (mehr Latenz, mehr Abhaengigkeiten).
- Sofortiges mTLS WebApp <-> Relay (mehr Aufwand bei geringem kurzfristigem Reward).

### 2.2 Audit-Store Best Practice (Supabase)

Empfehlung:

- Supabase als append-only Audit-Store (eigene Tabelle, minimierte Metadaten, keine Payloads).
- Asynchrones Schreiben (non-blocking) aus dem Relay:
  - Command-Response wird nicht auf Audit-Insert warten.
  - Audit-Events werden in In-Memory Queue gesammelt und gebatcht geschrieben.
- Bei Insert-Fehlern: Retry + Fehler-Metrik + degradierter Betrieb ohne Command-Blockade.

Warum:

- Gute Auditierbarkeit mit vorhandener Infrastruktur.
- Kein Einfluss auf die User-Latenz im Command-Flow.
- Nachvollziehbare Retention/Purge-Strategie in derselben Plattform moeglich.

## 3. Verifizierter Ist-Stand (relevante Gaps)

### Kritische Gaps

- Relay `POST /relay/command` braucht produktive Key-Provisionierung/Deployment fuer Caller-Assertion-Keys; Verifikation ist im Codepfad integriert.
- `bridge_hello` Auth ist implementiert (Bridge Keypair + Challenge-Response), aber globales Hard-Enforcement im Relay-Rollout noch optional per Env-Flag.

### Teilweise umgesetzt / bereits gut

- Relay -> Bridge Command-Signatur, TTL, Replay-Schutz vorhanden.
- Bridge Command-Allowlist vorhanden.
- Zod-Validierung fuer non-graphics Relay Commands vorhanden.
- Payload-Limits / Timeouts vorhanden.
- Pairing-Secret wird Bridge-seitig per ENV statt argv uebergeben.
- WebApp Legacy Pairing-URL-Flow entfernt (manuelles Pairing bleibt).
- Bridge Read- und Write-Endpoints sind nun breiter `local-or-token` geschuetzt (`/config*`, `/status`, `/devices`, `/outputs`, `/video/status`, `/relay/status`).
- Relay Caller-Assertion (Signatur + TTL + Replay + Payload-Hash) ist implementiert; Rollout ueber Env-Key-Provisionierung erforderlich.

## 4. Zielbild (dieser Refactor)

1. Kein Pairing-Secret in URLs, Browser-History oder Share-Links.
2. Relay signiert Commands nur fuer kryptografisch authentisierte WebApp-Server-Caller.
3. Bridge kann sich am Relay kryptografisch als enrolled Device ausweisen (Keypair).
4. Bridge-HTTP/WS Endpoints sind standardisiert klassifiziert und geschuetzt (local-or-token).
5. Audit-Events sind minimal, strukturiert, querybar und retention-faehig (Supabase), ohne Payloads.
6. Alle neuen Sicherheitschecks bleiben latenzneutral (lokale Verifikation, asynchrones Audit).

## 5. Latenz- und Performance-Gelander (verbindlich)

Diese Grenzen gelten fuer alle Umsetzungen:

- Keine zusaetzlichen externen Netzwerk-Calls im hot path pro Relay-Command zur Caller-Authentisierung.
- Keine synchrone Audit-DB-Schreibpflicht vor Command-Response.
- Signaturpruefungen nur lokal im Prozess (Relay/Bridge).
- Bridge Loopback-Requests bleiben ohne Zusatzkosten funktional (lokal immer erlaubt).

Messbare Guardrails (Zielwerte):

- Relay Caller-Assertion Verifikation: p95 < 1 ms pro Request (ohne DB-Check).
- Bridge `bridge_hello` Challenge-Verify: nur beim Connect/Reconnect, nicht pro Command.
- Audit-Insert: asynchron, kein Einfluss auf HTTP-Response-Zeit.

## 6. Workstreams und Tracker

Status-Legende:

- `TODO` noch offen
- `IN_PROGRESS` in Arbeit
- `DONE` umgesetzt/verifiziert
- `BLOCKED` blockiert

### WS-00 Dokumentations-Korrektur (Ist-Stand vs Annahmen)

Ziel: Falsche "umgesetzt"-Claims aus Sicherheits-/DSGVO-Dokus entfernen.

- [x] `docs/security/formale-risikodokumentation-dpia-retention.md` Statusblock auf echten Ist-Stand korrigieren
- [ ] Widersprueche zwischen `gdpr-implementation-plan.md`, `gdpr-compliance-bewertung-annahme.md`, `customer-security-access-gdpr.md` markieren/auflosen
- [ ] Dokumente mit klarem Label versehen: `Ist-Stand`, `Annahme`, `Zielbild`

Akzeptanz:

- Keine unzutreffenden Aussagen mehr zu Pairing-URL, Relay Caller-Auth, `bridge_hello`-Auth.

### WS-01 Pairing UX Refactor (manuell, ohne URL-Parameter)

Ziel: Pairing nur ueber manuelle Eingabe von `bridgeId` + `pairingCode`.

#### WebApp (broadify)

- [x] Legacy Pairing-Link Empfangslogik entfernen aus `components/bridge-connection.tsx`
- [x] Query/Hash Parsing fuer `bridgeId`/`pair` entfernen
- [x] `history.replaceState` Cleanup fuer Pairing-Link-Fall entfernen (nicht mehr noetig)
- [x] UI-Text anpassen: manuelles Pairing erklaeren (Bridge ID + Pairing Code manuell einfuegen)
- [ ] Optional: Paste-UX verbessern (z. B. "Bridge ID" und "Pairing Code" getrennte Inputs bleiben)
- [ ] Tests fuer Pairing-Dialog / manuelles Pairing (kein Auto-Open via URL)

#### Bridge Desktop (broadify-bridge-v2)

- [ ] Pairing-Dialog/Bridge-UI Texte explizit auf "manuell kopieren" anpassen
- [ ] Sicherstellen, dass keine Share-Link-Generierung mit Parametern existiert (falls vorhanden/alt)

Akzeptanz:

- WebApp verarbeitet keinen Pairing-Token aus URL mehr.
- User kann weiterhin manuell pairen (Bridge ID + Pairing Code).
- Keine Funktionseinbusse im bestehenden manuellen Pairing-Flow.

### WS-02 Bridge Endpoint Hardening (local-or-token Standardisierung)

Ziel: Alle relevanten Endpoints konsistent schuetzen, ohne lokalen Desktop-Flow zu beeintraechtigen.

#### Sofort (Phase 0 Abschluss)

- [x] `POST /config` mit `enforceLocalOrToken()` schuetzen
- [x] `POST /config/clear` mit `enforceLocalOrToken()` schuetzen

#### Sinnvoll fuer DSGVO / low risk, low latency

- [x] `GET /status` schuetzen (local-or-token)
- [x] `GET /devices` schuetzen (local-or-token)
- [x] `GET /outputs` schuetzen (local-or-token)
- [x] `GET /video/status` schuetzen (local-or-token)
- [x] `GET /relay/status` schuetzen (local-or-token)

#### Infrastruktur / Robustheit

- [ ] Route-Schutz als wiederverwendbares Muster definieren (pro Route-Gruppe statt Copy/Paste)
- [ ] `BRIDGE_API_TOKEN` Erzeugung/Provisionierung definieren (aktuell nur gelesen, nicht gesetzt)
- [ ] Token-Vergleich auf timing-safe compare umstellen (Best Practice)
- [ ] Doku-Tabelle "Endpoint-Klassifizierung" (read/write + Schutzlevel) erstellen

Akzeptanz:

- Lokale Electron-Desktop-Nutzung bleibt unveraendert schnell/funktional.
- LAN-/Remote-Zugriffe auf geschuetzte Endpoints nur mit Token.
- Keine offenen mutierenden Endpoints mehr.

### WS-03 Relay Caller Authentication (WebApp Server -> Relay)

Ziel: Relay signiert Commands nur fuer kryptografisch authentisierte WebApp-Server-Requests.

#### Design (Phase 1)

- [x] Assertion-Format festlegen (JWT oder signiertes JSON; empfohlen: Ed25519/JWT)
- [x] Claims definieren:
  - `actor_user_id`
  - `org_id`
  - `role`
  - `bridge_id`
  - `command`
  - `payload_hash`
  - `iat`, `exp`, `jti`
  - `iss`, `kid`
- [ ] Key-Management fuer WebApp-Signing-Key definieren (private key nur serverseitig)
- [x] Relay-Verifikation (lokale Signaturpruefung + TTL + Replay) implementieren
- [x] Relay liest `org_id` aus Assertion (Fallback nur wenn Assertion in non-prod deaktiviert ist); `actor` wird aus Assertion geloggt
- [x] WebApp API Routes (`/api/bridges/pair`, `/api/bridges/[bridgeId]/command`) senden Assertion mit

#### Hardening

- [x] Replay-Store fuer Assertion `jti` im Relay (TTL-basiert)
- [x] `payload_hash` Uebereinstimmung erzwingen
- [x] Fehlversuche strukturiert loggen (ohne Payload)

Akzeptanz:

- Ohne gueltige Assertion kein `/relay/command`.
- Relay kann `org_id`-Spoofing aus Body nicht mehr ausnutzen.
- Keine merkbare Zusatzlatenz (nur lokale Verify).

### WS-04 Device Enrollment + Bridge Keypair + `bridge_hello` Auth

Ziel: Bridge identifiziert sich gegen Relay als echtes enrolled Device.

#### Enrollment (Pairing nur initial)

- [x] Enrollment-Datenmodell definieren (Supabase):
  - Bridge Public Key
  - Key Status (active/revoked/rotating)
  - `enrolled_at`, `rotated_at`
  - optional `last_auth_at`
- [x] Pairing-Erfolg erweitert um initiales Enrollment / Key Registration
- [x] Pairing-Code bleibt nur Onboarding-Secret, nicht Dauer-Auth

#### Bridge Keypair

- [x] Bridge erzeugt lokales Keypair (Ed25519 empfohlen)
- [x] Private Key sicher lokal speichern (Bridge userDataDir, file permissions)
- [x] Public Key bei Enrollment registrieren
- [ ] Key Rotation Strategie definieren (spater, aber Datenmodell jetzt vorbereiten)

#### `bridge_hello` Auth Flow

- [x] WS Challenge-Response Protokoll definieren (nonce/challenge + signierter Proof)
- [x] Relay verifiziert Proof gegen gespeicherten Public Key
- [x] Relay registriert Bridge erst nach erfolgreichem Verify
- [x] Reconnect/Clock-Skew/Replay Regeln definieren

Akzeptanz:

- Nur Bridge mit gueltigem Key kann `bridgeId` registrieren (fuer enrolled Bridges; globales Hard-Enforcement optional per Relay-Flag).
- Reine `bridgeId`-Impersonation am Relay ist blockiert.
- Kein Zusatzaufwand im Command-Hot-Path (nur bei Connect/Reconnect).

### WS-05 Rollenmodell fuer Bridge-Commands (RBAC -> Scopes)

Ziel: Rollen wirken auf Remote-Commands technisch durchgaengig.

- [ ] Command-Matrix definieren (`viewer/member/admin/owner`)
- [ ] WebApp Server liefert `role` in Caller-Assertion
- [ ] Relay mappt Rolle auf erlaubte Commands/Scopes
- [ ] Bridge Scope-Checks ggf. erweitern (falls feinere Scopes eingefuehrt werden)
- [ ] Negativtests fuer unerlaubte Rollen pflegen

Empfohlene Start-Matrix:

- `viewer`: `get_status`, `engine_get_status`, `engine_get_macros`, `graphics_list`
- `member`: plus `graphics_send/update/remove`
- `admin/owner`: plus `engine_connect/disconnect`, `graphics_configure_outputs`, Pairing/Admin-Aktionen

Akzeptanz:

- Unerlaubte Commands werden vor Signierung (Relay) abgelehnt.
- Bridge akzeptiert nur Scopes passend zum Command.

### WS-06 Audit Logging (Supabase, append-only, non-blocking)

Ziel: Auditierbarkeit fuer Remote Access ohne Payload-Leak und ohne Latenzaufschlag.

#### Datenmodell

- [ ] `audit_events` Tabelle in Supabase entwerfen (append-only)
- [ ] Minimale Felder definieren:
  - `event_type`
  - `timestamp`
  - `request_id`
  - `session_id` (optional / Phase 2 JIT)
  - `actor_user_id`
  - `org_id`
  - `bridge_id`
  - `command`
  - `result` (success/failure)
  - `error_code` (optional)
  - `source` (`relay`, `webapp`, `bridge`)
  - `metadata` (streng minimiert)
- [ ] Keine Payloads, keine Pairing-Secrets, keine Access Tokens speichern

#### Schreibpfad (Relay)

- [ ] In-Memory Queue + Batch Insert implementieren
- [ ] Retry/Backoff fuer Insert-Fehler
- [ ] Queue-Overflow Verhalten definieren (droppen + alert statt Command blocken)
- [ ] Metriken/Logs fuer Audit-Pipeline-Health

#### Zugriff / Governance

- [ ] Strenge RLS/Service-Role-only Insert Strategie definieren
- [ ] Read-Pfade fuer Admin/Audit nur ueber serverseitige APIs
- [ ] Retention/Purge Job planen

Akzeptanz:

- Audit-Events querybar nach `org_id`, `bridge_id`, `actor_user_id`, `request_id`.
- Kein Payload-Leak in Audit-Tabelle.
- Relay-Response wartet nicht auf Audit-Insert.

### WS-07 Retention / DSAR / Compliance-Betrieb (operationalisieren)

Ziel: Dokumentierte Regeln in technische und organisatorische Prozesse ueberfuehren.

- [ ] Retention-Matrix aus `formale-risikodokumentation-dpia-retention.md` in umsetzbare Jobs/Runbooks uebertragen
- [ ] Purge-Jobs definieren (Audit, Betriebslogs, Security-Logs)
- [ ] Legal-Hold / Incident-Hold Prozess definieren
- [ ] DSAR Export-Prozess (Supabase + App-Daten + Audit-Nachweise) spezifizieren
- [ ] DSAR Loesch-/Anonymisierungsstrategie pro Datenklasse definieren
- [ ] Backup/Restore Runbook inkl. Re-Deletion nach Restore dokumentieren

Akzeptanz:

- Test-DSAR innerhalb SLA durchfuehrbar.
- Retention/Purge nachweisbar (Reports/Logs).

### WS-08 Phase-2 Backlog (spaeter, aber vorbereiten)

Ziel: Enterprise-Hardening ohne aktuelle Phase-1 Umsetzung zu blockieren.

- [ ] mTLS Bridge <-> Relay (mit Rotation) planen
- [ ] Just-in-Time Remote Access mit lokaler Zustimmung planen
- [ ] Rate Limits pro Org/Bridge/Command planen
- [ ] Fine-grained Response Minimization planen

Hinweis:

- WS-03 + WS-04 so designen, dass spaeteres mTLS/JIT ohne Rewrite moeglich ist.

## 7. Umsetzungspakete (empfohlene Reihenfolge)

### Paket A (kritische Security-Luecken, hoher Reward)

- [x] WS-03 Relay Caller Authentication
- [x] WS-04 Bridge Keypair + `bridge_hello` Auth

### Paket B (Phase 0 Abschluss + UX Klarheit)

- [x] WS-01 Pairing UX Refactor (manuell, ohne URL-Parameter)
- [x] WS-02 Endpoint Hardening (`/config*` sofort, read-only Endpoints danach)

### Paket C (Governance + Nachvollziehbarkeit)

- [x] WS-06 Audit Logging (Supabase)
- [x] WS-00 Dokumentations-Korrektur

### Paket D (Betrieb / Compliance)

- [x] WS-07 Retention / DSAR / Backup-Restore Operationalisierung

### Paket E (spaeter)

- [ ] WS-08 Phase-2 Backlog (mTLS/JIT/Rate Limits)

## 8. Tracking-Tabelle (Kurzstatus)

| ID    | Thema                                       | Prioritaet | Status      | Repo(s)                                     | Latenz-Risiko            | Abhaengigkeiten    |
| ----- | ------------------------------------------- | ---------- | ----------- | ------------------------------------------- | ------------------------ | ------------------ |
| WS-03 | Relay Caller Auth                           | P0         | IN_PROGRESS | `broadify`, `relay`                         | Niedrig (offline verify) | Key mgmt           |
| WS-04 | Bridge Keypair + `bridge_hello` Auth        | P0         | DONE        | `bridge`, `relay`, `broadify` (Pairing API) | Niedrig (connect only)   | Enrollment schema  |
| WS-01 | Pairing URL Removal + manual UX             | P1         | IN_PROGRESS | `broadify`, `bridge`                        | Keins                    | none               |
| WS-02 | Bridge Endpoint Hardening                   | P1         | IN_PROGRESS | `bridge`                                    | Sehr niedrig             | Token provisioning |
| WS-06 | Audit Logging in Supabase                   | P1         | TODO        | `relay`, `broadify`?, Supabase              | Niedrig (async)          | Audit schema       |
| WS-00 | Doku-Korrektur                              | P1         | TODO        | `bridge` docs                               | Keins                    | Ist-Stand review   |
| WS-05 | Rollen -> Scopes                            | P2         | TODO        | `broadify`, `relay`, `bridge`               | Niedrig                  | WS-03              |
| WS-07 | Retention/DSAR Betrieb                      | P2         | TODO        | `broadify`, ops/docs, Supabase              | Keins im hot path        | Audit + policy     |
| WS-08 | Enterprise Hardening (mTLS/JIT/Rate limits) | P3         | TODO        | alle                                        | variabel                 | WS-03/WS-04        |

## 9. Test- und Abnahmeplan (kompakt)

### Security Tests

- [ ] Relay lehnt `/relay/command` ohne Assertion ab (`401`)
- [ ] Relay lehnt Replay-Assertion (`jti`) ab
- [ ] Relay lehnt `payload_hash`-Mismatch ab
- [ ] Relay lehnt `bridge_hello` ohne gueltigen Signatur-Proof ab (nach Aktivierung globales Hard-Enforcement oder fuer enrolled Bridges)
- [ ] Bridge lehnt unbekannte Commands weiterhin ab
- [ ] Bridge lehnt ungueltige Scopes weiterhin ab
- [ ] `/config*` ohne Token (nicht lokal) wird blockiert

### Regression / UX

- [ ] Manuelles Pairing funktioniert weiterhin end-to-end
- [ ] Keine Pairing-Daten in URL/Hash werden verarbeitet
- [ ] Lokale Desktop-Nutzung (Loopback) unveraendert
- [ ] Keine merkbare Verlangsamung im Remote-Command-Flow

### WS-04 Rollout-Hinweise (Stand 25. Februar 2026)

- Neue Supabase-Migration erforderlich: `broadify/supabase/migrations/20260225120000_add_bridge_enrollment_keys.sql`
- Pairing speichert aktive Bridge-Enrollment-Keys in `bridge_enrollment_keys`
- Bridge erzeugt Ed25519-Keypair lokal in `userDataDir/security/relay-bridge-identity.json`
- Relay fordert bei vorhandenen Enrollment-Keys automatisch `bridge_hello` Challenge-Response an
- Globales Hard-Enforcement kann spaeter aktiviert werden mit `RELAY_REQUIRE_BRIDGE_HELLO_AUTH=true`

### Observability / Audit

- [ ] Audit-Event pro Remote-Command vorhanden (minimal, ohne Payload)
- [ ] Query nach `request_id` korreliert Command-Flow
- [ ] Audit-Insert-Fehler erzeugen Alert/Metrik, blockieren aber keinen Command

## 10. Offene Architekturentscheidungen (nur wenn waehrend Umsetzung noetig)

Aktuell bereits entschieden:

- Bridge Keypair
- Manuelles Pairing ohne URL-Parameter
- Supabase als Audit-Store

Nur noch bei Bedarf klaeren:

- [ ] Assertion-Format final: JWT (JOSE) vs proprietaeres signiertes JSON
- [ ] Audit-Queue persistieren (optional) oder In-Memory + Telemetrie ausreichend
- [ ] Key Rotation UX fuer Bridge (transparent vs admin-initiiert)
