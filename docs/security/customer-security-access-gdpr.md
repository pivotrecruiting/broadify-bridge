# Broadify Sicherheits-, Zugriffs- und DSGVO-Dokumentation

Stand: 19. Februar 2026

## 1. Ziel und Scope

Diese Dokumentation fasst den aktuellen technischen Stand zu Sicherheit, Zugriff, Fremdzugriff (Remote Access), DSGVO/GDPR, Drittanbietern und Schutzmechanismen zusammen.

Analysierter Scope:

- Bridge Desktop + lokale Bridge (`broadify-bridge-v2`)
- Webapp (`broadify`, Next.js)
- Relay Server (`broadify-relay`)
- Datenbank/Auth (Supabase Projekt `https://%%%.supabase.co`)
- Hosting/Plattformen: Vercel, Fly.io, Supabase, Sentry

Hinweis: Keine Rechtsberatung. Diese Bewertung ist technisch-organisatorisch.

## 2. Gesamtarchitektur (Sicherheitsrelevanz)

- Desktop-App (Electron) startet die lokale Bridge, verwaltet Pairing-Code, zeigt Status, pollt Health.
- Bridge (Fastify + WS) steuert Engine/Outputs/Graphics lokal und verbindet sich outbound zum Relay.
- Webapp (Next.js) sendet Commands serverseitig an Relay und nutzt Relay-WS fuer Graphics-Statusupdates.
- Relay (Fly.io) vermittelt Commands zwischen Webapp und Bridge, signiert Commands und stellt JWKS bereit.
- Supabase liefert Auth, Session, Org-Zuordnung und RLS-gesicherte Datenhaltung.

## 3. Verbindungswege: Polling, WebSocket, Command-Flow

### 3.1 Desktop <-> Bridge (lokal)

- Polling Health: `src/electron/services/bridge-health-check.ts` (2s Intervall, 5s Timeout).
- Desktop ruft Bridge-HTTP Endpoints lokal auf (z. B. `/status`, `/engine/*`, `/outputs`, `/relay/status`).

### 3.2 Webapp -> Relay -> Bridge (Commands)

- Webapp API Route: `/api/bridges/[bridgeId]/command` in `broadify/app/api/bridges/[bridgeId]/command/route.ts`.
- Route erzwingt Org-Kontext (`getCurrentOrgContext`) und Org-Bridge-Mapping vor Relay-Forward.
- Relay Endpoint: `POST /relay/command` in `broadify-relay/src/index.ts`.
- Bridge empfängt per WS `command`, validiert Signatur/TTL/Replay, verarbeitet via `command-router`.

### 3.3 Webapp <-> Relay WebSocket (Status)

- Hook `broadify/hooks/use-relay-graphics-updates.ts`:
  - holt Supabase `access_token`
  - sendet `webapp_subscribe { bridgeId, accessToken }`
  - erhält `bridge_event` (`graphics_status`)

### 3.4 Pairing

- Desktop generiert 8-stelligen Pairing-Code mit 10 Minuten TTL (`src/electron/services/bridge-pairing.ts`).
- Pairing-Validation läuft über Relay-Command `bridge_pair_validate`.
- Bei Erfolg verknuepft Webapp die Bridge mit Organisation in Supabase (`organization_bridges`).

## 4. Implementierte Sicherheitsmechanismen

### 4.1 Relay -> Bridge Command-Schutz

- Signierte Commands (EdDSA) im Relay: `broadify-relay/src/index.ts`.
- Bridge-Validierung von `meta`, `scope`, `iat/exp`, `jti` Replay-Schutz: `apps/bridge/src/services/relay-client.ts`.
- JWKS-Unterstützung und URL-Härtung (HTTPS, keine privaten IPs fuer JWKS): `apps/bridge/src/services/relay-client.ts`.

### 4.2 Payload-/Transportschutz

- HTTP body limits und WS payload limits: 2 MB in Bridge und Relay.
- Timeouts fuer Command-Flows (Relay + Webapp API).

### 4.3 Lokale Zugriffsschranken (teilweise)

- Route-Guard `local-or-token` vorhanden: `apps/bridge/src/routes/route-guards.ts`.
- Aktiv auf: `/engine/*`, `/ws`, `/logs`.

### 4.4 Pairing-Secret Handling

- Pairing-Daten werden ueber ENV statt CLI Args an Bridge-Prozess gegeben (`src/electron/services/bridge-process-manager.ts`).

### 4.5 Supabase Auth + RLS

- Webapp nutzt Supabase Session + Org-Kontext fuer Bridge-Operationen.
- Public-Tabellen haben RLS aktiviert.
- Policies fuer Org-Mitgliedschaft/Org-Admin sind vorhanden (u. a. `organization_bridges`, `bridges`, `graphic_*`, `control_*`).

## 5. Kritische Befunde (Code-Stand)

### 5.1 Kritisch: Relay Command-Endpoint ohne Client-Authentifizierung

Betroffen:

- `broadify-relay/src/index.ts` (`POST /relay/command`)

Befund:

- Endpoint verlangt `orgId` im Body und prueft Org-Bridge-Mapping.
- Es gibt aber keine harte Verifikation, dass der aufrufende Client zu dieser Org gehoert (kein JWT/Service-Auth am Endpoint selbst).

Risiko:

- Bei bekannter `bridgeId` + `orgId` koennen unautorisierte Dritte Commands triggern.

### 5.2 Hoch: Bridge-Registrierung am Relay ohne Bridge-Authentisierung

Betroffen:

- `broadify-relay/src/index.ts` (`bridge_hello` Registrierung)

Befund:

- `bridge_hello` registriert nur ueber `bridgeId`; keine Device-Auth/mTLS.

Risiko:

- Bridge-Impersonation/Session-Übernahme (DoS/Hijack der Command-Zustellung) moeglich.

### 5.3 Hoch: Nicht alle Bridge-HTTP-Routen sind abgesichert

Betroffen:

- Registrierte Routen in `apps/bridge/src/server.ts`
- Ohne Guard: `/status`, `/devices`, `/outputs`, `/config`, `/video/status`

Befund:

- Guard ist nur fuer `/engine`, `/ws`, `/logs` aktiv.
- Gleichzeitig CORS ist global offen (`origin: true`).

Risiko:

- Bei LAN-Bindings (`0.0.0.0` oder Interface-IP) sind unautorisierte Konfigurations- und Informationszugriffe moeglich.

### 5.4 Hoch: Remote Access in Desktop-Flow standardmaessig aktiv

Betroffen:

- `src/electron/main.ts` (`const relayEnabled = true`)

Befund:

- Desktop-Start aktiviert Relay immer.
- Secure-Default "Remote Access OFF" wird so nicht eingehalten.

### 5.5 Mittel: Pairing-Code weiterhin URL-kompatibel im Webapp-Frontend

Betroffen:

- `broadify/components/bridge-connection.tsx` (`pair` aus URL hash)

Befund:

- Frontend liest `pair` aus URL-Hash ein.

Risiko:

- Pairing-Secrets koennen in Browser-Historie, Screenshots oder geteilten Links landen.

### 5.6 Mittel: BrowserWindow Security-Flags nicht explizit gesetzt

Betroffen:

- `src/electron/main.ts` (nur `preload` gesetzt)

Befund:

- `contextIsolation: true` und `nodeIntegration: false` werden nicht explizit konfiguriert.

Risiko:

- Implizite Defaults sind fragiler als explizite Hardening-Konfiguration.

### 5.7 Mittel: Supabase Security Advisor Warnungen

Gefunden:

- `function_search_path_mutable` fuer `public.set_updated_at` und `public.has_role`
- `auth_leaked_password_protection` deaktiviert

Risiko:

- Erhoehte Angriffsfläche bei SQL-Funktionen und schwächere Passwortsicherheit.

## 6. DSGVO/GDPR Bewertung (technisch)

### 6.1 Positiv

- Datenzugriff im Produktkern ist org-basiert (Webapp + RLS).
- Pairing ist zeitlich begrenzt.
- Logging wurde in Teilen auf Summaries reduziert.
- Signierte Relay-Commands mit Replay-Schutz verbessern Integrität.

### 6.2 Luecken fuer belastbare DSGVO-Konformitaet

- Fehlende durchgehende Authentisierung am Relay Command-Entry.
- Kein konsistentes Zero-Trust-Modell auf allen Bridge-Endpunkten.
- Keine zentral sichtbare DSAR-Implementierung (Auskunft/Loeschung/Export-Prozesse) im Applikationscode.
- Keine dokumentierte Data-Retention/Loeschfristen-Policy im Code-/Ops-Stand.
- Drittland-Transfer-/Subprozessor-Transparenz nicht als kundentaugliche Systemdoku konsolidiert.

### 6.3 Einordnung

- "DSGVO-faehig" ist mit gezielten Massnahmen erreichbar.
- "DSGVO-nachweisbar konform" fuer Enterprise-Audits ist im aktuellen Stand noch nicht gegeben.

## 7. Drittanbieter und Datenfluesse

| Anbieter                | Zweck                           | Potentielle Datenarten                               | Relevanz          |
| ----------------------- | ------------------------------- | ---------------------------------------------------- | ----------------- |
| Supabase                | Auth, DB, REST, RLS             | User-/Org-Daten, Bridge-Zuordnungen, Presets/Configs | Kernsystem        |
| Fly.io                  | Hosting Relay                   | Bridge-IDs, orgId, Command-Metadaten, ggf. Payloads  | Remote-Steuerpfad |
| Vercel                  | Hosting Webapp                  | Session-Cookies/Tokens (serverseitig), API-Traffic   | Frontend/Backend  |
| Sentry (Web + Electron) | Error Monitoring                | Fehlerkontext, potenziell technische Metadaten       | Observability     |
| GitHub API              | Release-Infos (Webapp endpoint) | Versions-/Artifact-Metadaten                         | Nebenpfad         |

Hinweis: Fuer Auftragsverarbeitung (Art. 28), Drittlandtransfer (Art. 44), TOMs und SCC ist ein separates juristisch abgestimmtes AV-/Transfer-Paket erforderlich.

## 8. Doku-Audit: Vollstaendigkeit und Aktualitaet

### 8.1 Veraltet oder inkonsistent

- `docs/security/gdpr-implementation-plan.md`
  - markiert "Pairing-Code nicht in URLs" als umgesetzt, aber Webapp liest weiter `pair` aus URL-Hash.
  - beschreibt Auth-Lage teilweise nicht mehr exakt zum aktuellen Code (teils verbessert, teils weiterhin offen).
- `docs/security/relay-data-traffic.md`
  - beschreibt Teile des Flows noch im alten Request-Schema ohne konsistente `orgId`-Darstellung in allen Diagrammstellen.
  - enthält veraltete Aussage, dass AuthN/AuthZ nur Phase-1 sei, obwohl Signatur/Scope/Replay bereits aktiv ist.
- `broadify/docs/webapp-relay-bridge-contract.md`
  - beschreibt Relay-Request ohne aktuelle Sicherheitsmeta (orgId/signierte Envelope im Relay->Bridge Abschnitt).
- `broadify/docs/relay/relay-doc.md` und `broadify-relay/README.md`
  - alte Vertragsbeschreibung (`{bridgeId, command, payload}`), ohne aktuellen Sicherheits- und Subscription-Flow.

### 8.2 Nicht vollstaendig fuer Kundenzweck

- Keine zentrale, konsolidierte Kundendoku ueber alle Repos mit:
  - End-to-End Trust-Boundaries
  - Datenkategorien je Verbindungsweg
  - Drittanbieter + Compliance-Map
  - Risiko- und Massnahmenkatalog

## 9. Priorisierte Massnahmen (empfohlen)

### 0-14 Tage (kritisch)

1. Relay `/relay/command` verpflichtend authentisieren (JWT oder serverseitiges Service-Token mit Verifikation).
2. Bridge-Registrierung am Relay absichern (Enrollment-Secret, besser mTLS).
3. Alle mutierenden Bridge-Routen auf `local-or-token` umstellen (`/config` zuerst), CORS strikt whitelisten.
4. Desktop: Relay nicht default aktivieren, sondern expliziter Opt-in (pro Start oder persistente Einstellung mit Hinweis).

### 15-45 Tage (hoch)

1. Pairing-Code URL-Hash-Flow entfernen.
2. Electron `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` explizit setzen und testen.
3. `openExternal` auf strikte URL-Allowlist (https + Host-Allowlist) begrenzen.
4. Supabase Advisor-Funde beheben:
   - `search_path` in Funktionen fixieren
   - Leaked password protection aktivieren

### 45-90 Tage (compliance)

1. Audit-Logging (Actor, Org, Command, Request-ID, Ergebnis) einführen.
2. Data-Retention und DSAR-Prozesse technisch implementieren und dokumentieren.
3. Kundendokumente fuer AVV/Subprozessoren/Transfer Impact standardisieren.

## 10. Fazit

Der Stack hat bereits wichtige Sicherheitsbausteine (Signatur, Replay-Schutz, RLS, Org-Scoping in Webapp). Fuer belastbaren, weltweit exponierten Fernzugriff und auditfeste DSGVO-Nachweisbarkeit fehlen aktuell aber noch mehrere zentrale Kontrollen, vor allem am Relay-Einstieg und an ungeschuetzten Bridge-Endpunkten.
