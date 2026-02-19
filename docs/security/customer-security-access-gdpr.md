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

### 4.3 Lokale Zugriffsschranken

- Route-Guard `local-or-token` vorhanden: `apps/bridge/src/routes/route-guards.ts`.
- Aktiv auf: `/engine/*`, `/ws`, `/logs`.

### 4.4 Pairing-Secret Handling

- Pairing-Daten werden ueber ENV statt CLI Args an Bridge-Prozess gegeben (`src/electron/services/bridge-process-manager.ts`).

### 4.5 Supabase Auth + RLS

- Webapp nutzt Supabase Session + Org-Kontext fuer Bridge-Operationen.
- Public-Tabellen haben RLS (Row-Level Security Policies) aktiviert.
- Policies fuer Org-Mitgliedschaft/Org-Admin sind vorhanden (u. a. `organization_bridges`, `bridges`, `graphic_*`, `control_*`).

## 5. Drittanbieter und Datenfluesse

| Anbieter                | Zweck                           | Potentielle Datenarten                               | Relevanz          |
| ----------------------- | ------------------------------- | ---------------------------------------------------- | ----------------- |
| Supabase                | Auth, DB, REST, RLS             | User-/Org-Daten, Bridge-Zuordnungen, Presets/Configs | Kernsystem        |
| Fly.io                  | Hosting Relay                   | Bridge-IDs, orgId, Command-Metadaten, ggf. Payloads  | Remote-Steuerpfad |
| Vercel                  | Hosting Webapp                  | Session-Cookies/Tokens (serverseitig), API-Traffic   | Frontend/Backend  |
| Sentry (Web + Electron) | Error Monitoring                | Fehlerkontext, potenziell technische Metadaten       | Observability     |
| GitHub API              | Release-Infos (Webapp endpoint) | Versions-/Artifact-Metadaten                         | Nebenpfad         |

Hinweis: Fuer Auftragsverarbeitung (Art. 28), Drittlandtransfer (Art. 44), TOMs und SCC ist ein separates juristisch abgestimmtes AV-/Transfer-Paket erforderlich.
