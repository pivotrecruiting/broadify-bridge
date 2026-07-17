# Broadify Bridge Agent Rules

Diese Regeln gelten fuer `broadify-bridge`. Globale persoenliche Regeln liegen in `~/.codex/AGENTS.md`; wiederverwendbare Spezialfaehigkeiten liegen in `~/.codex/skills`.

## Projektrolle

- Broadify Bridge ist die Desktop- und lokale Bridge-Anwendung fuer Device Discovery, Relay-Commands, Realtime Graphics Output und Helper-Prozesse.
- Desktop UI, Electron Main/Preload, Bridge Server, Shared Protocol und native Helper sind strikt getrennte Zonen.
- Bridge fuehrt lokale Device-/Graphics-Aktionen aus und kommuniziert mit WebApp/Relay ueber definierte Contracts.

## Stack

- Electron Desktop App.
- React 19 + TypeScript + Vite fuer UI.
- Node.js + TypeScript fuer Bridge Runtime.
- Fastify/WS-nahe Bridge Services.
- Zod fuer Input-/Command-Validation.
- pino/strukturierte Logs.
- Jest fuer Tests.
- Native Helper/Addons fuer FrameBus, Display, DeckLink, Meeting/Graphics Rendering und VCam.
- Packaging ueber electron-builder.

## Architekturgrenzen

- Desktop Main: `src/electron/*`, OS Zugriff, Fenster, IPC, Bridge/Helper Lifecycle.
- Preload: einzige whitelisted Bruecke zwischen Renderer und Main.
- Renderer UI: `src/*` und UI-Komponenten, keine direkten Node APIs.
- Bridge Server: `apps/bridge/src/*`, keine Electron-UI-Abhaengigkeiten.
- Shared Protocol: `packages/protocol/*`, Single Source of Truth fuer gemeinsame Contracts.
- Native/Helper: `apps/bridge/native/*` und Build-Skripte.
- Doku: `docs/bridge/*`, `docs/desktop/*`, `docs/integration/*`, `docs/legal/*`.

## Verbindliche Graphics-Regeln

- Graphics ist Single-Path: Single Renderer, FrameBus als Data Plane, IPC/HTTP/WS als Control Plane.
- Kein `key_fill_split_sdi` wieder einfuehren.
- Kein Multi-Window Renderer-Fallback.
- Kein Bridge-Compositing/Ticker als Fallback.
- Keine Runtime-Umschaltung ueber `BRIDGE_GRAPHICS_RENDERER_SINGLE`.
- Bei Graphics-/Helper-Aenderungen die passende Doku unter `docs/bridge/*` aktualisieren.

## Security

- Renderer: `contextIsolation: true`, `nodeIntegration: false`; keine Node APIs im Renderer.
- Preload-API minimal und whitelisted halten.
- Alle IPC-, HTTP-, WS- und Relay-Command-Inputs validieren.
- Relay Commands nur ueber Allowlist/Policy/Schemas ausfuehren.
- Keine Secrets, Tokens, Enrollment Keys oder personenbezogenen Daten in Logs.
- Renderer/Helper IPC nur lokal und mit Token-/Handshake-/Payload-Limits, wo vorhanden.
- Untrusted Pfade, URLs und Commands nie ungeprueft an Main, Bridge oder Helper weiterreichen.

## Coding-Konventionen

- Dateien/Ordner: `kebab-case`.
- React Components: `PascalCase`.
- Funktionen/Variablen: `camelCase`.
- Konstanten: `UPPERCASE_SNAKE_CASE`.
- Type-Aliases: Suffix `T`, wenn im betroffenen Bereich etabliert.
- JSON Message Keys konsistent `snake_case`.
- Code-Kommentare und JSDoc auf Englisch.
- Bestehende Boundary-Patterns und lokale Tests vor Aenderungen lesen.

## Tests und Verifikation

Relevante Kommandos:

```bash
npm run lint
npm run test:jest
npm run build:protocol
npm run build:bridge
npm run build:graphics-renderer
npm run build:meeting-helper
npm run build:vcam-helper
npm run build
```

Fuer gezielte Jest-Tests:

```bash
npx jest path/to/file.test.ts --runInBand
```

Waehle die engste sinnvolle Verifikation. Native Helper Builds koennen plattform-/SDK-abhaengig sein; wenn sie nicht laufen, Grund und verbleibendes Risiko nennen.

## Passende globale Skills

- `$code-quality-refactor` fuer risikoarme Refactors.
- `$testing-and-verification` fuer Test- und Build-Auswahl.
- `$supabase-schema-migrations` und `$supabase-rls-and-security` nur fuer `supabase/*` oder Web/Relay-gekoppelte DB-Aenderungen.
- `$nextjs-feature-implementation` ist fuer dieses Repo normalerweise nicht passend, ausser es geht um projektuebergreifende WebApp-Kontrakte.
