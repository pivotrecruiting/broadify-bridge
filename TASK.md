# Task: Relay hinter Firmen-TLS-Inspection erreichbar machen (OS Trust Store)

## Raw request
Neukunde, Erstinstallation auf verwaltetem Windows-Laptop: Bridge-Pairing in
Broadify Meeting schlägt fehl. Bridge-Log: `[Relay] WebSocket error: self signed
certificate in certificate chain` im Reconnect-Backoff, Close-Code 1006. Alles
Lokale gesund. Auftrag: Enterprise-Lösung auf RC bauen, hohe Sicherheit, DRY,
keine Annahmen, ganze Kette prüfen, keine anderen Funktionen ändern.

## Context
- Customer / project: Neukunde, Windows, Firmen-Netz mit SSL-Inspection
- Worktree / branch: `../broadify-bridge-worktrees/relay-system-ca-trust` / `feature/relay-system-ca-trust`
- Base branch: `dev` (v0.27.1-rc.17)

## Plan
1. Root Cause belegen: Bridge läuft als Node-Prozess (ELECTRON_RUN_AS_NODE), `ws`
   ohne CA-Optionen, Node vertraut nur der eingebauten CA-Liste; Firmen-Root-CA
   liegt nur im OS-Speicher. Lokal nachgestellt (Kette mit fremder Root gegen
   Electron-als-Node): exakt `SELF_SIGNED_CERT_IN_CHAIN`.
2. Fix an der Quelle: Spawn-Vertrag setzt `NODE_USE_SYSTEM_CA=1` (Node >= 22.19,
   Electron 39 bringt Node 22.22.1), expliziter Elternwert wird respektiert,
   `NODE_EXTRA_CA_CERTS` bleibt durchgereicht.
3. Diagnose statt stiller Schleife: Startzeile `[RuntimeDiagnostics] TLS trust
   store {...}`; Relay-Socket-Fehler mit Node-Code und Handlungshinweis.
4. Doku: Support-Runbook, Fehlerkatalog, Relay-Protokoll, README.
5. Nicht in diesem Task (bewusst): Proxy-Unterstützung, UI-Anzeige des Grundes.

## Acceptance criteria
1. `buildBridgeSpawnEnv` liefert `NODE_USE_SYSTEM_CA=1` in Dev und Prod; ein
   vorhandener Wert (`0`, ``, `1`) bleibt unverändert; `NODE_EXTRA_CA_CERTS`
   wird durchgereicht. (Test: bridge-process-contract.test.ts)
2. Bridge loggt beim Start den Trust-Store-Status, ohne jemals zu werfen, auch
   auf Runtimes ohne `tls.getCACertificates`. (Tests: tls-trust-store.test.ts,
   runtime-diagnostics.test.ts)
3. Relay-Fehler ohne Code werden byte-identisch wie bisher geloggt; Fehler mit
   Code enthalten `(code: X)`; nicht vertraute Ketten enthalten Hinweis mit
   Trust-Store-Zustand; keine Umgebungswerte im Text. (Tests:
   relay-socket-error.test.ts, relay-client.test.ts)
4. Keine Verhaltensänderung außer Env-Variable und Log-Zeilen; voller Jest,
   Lint, Bridge-Build, Electron-Typecheck grün.

## Review
- Round: 1/3
- Verdict: PASS (unabhängiger Verifier, read-only: Lint 0, Zielsuiten 81/81,
  build:bridge 0, tsc src/electron 0; Electron-Node 22.22.1 honoriert
  NODE_USE_SYSTEM_CA=1 empirisch 144 → 156)
- Must-fix (open): none
- Notes (non-blocking, umgesetzt): DRY-Helfer `isSystemCaEnabled`;
  relay-protocol.md-Formulierung auf Runbook-Niveau angeglichen; prozessweite
  Wirkung der Trust-Erweiterung dokumentiert; Typecheck-Ziel korrigiert auf
  `src/electron/tsconfig.json`
- Notes (non-blocking, offen): Windows-Feldtest hinter echter Inspection;
  vorbestehende tsc-Fehler in Bridge-Testdateien (nicht Teil dieses Tasks)
- Handoff to human (if any): Merge-Go für PR gegen dev, danach RC-Schnitt

## Verification
- [x] Tests pass: voller Lauf 185 Suites grün; Zielsuiten 82 Tests
      grün; Vorher-Beweis: mit Produktionsdateien auf dev-Stand schlagen die
      drei erweiterten Suiten fehl (3 failed / 61 passed), danach grün
- [x] Lint / type-check pass: `npm run lint` exit 0, `npm run build:bridge`
      exit 0, `npx tsc --noEmit -p src/electron/tsconfig.json` exit 0
- [ ] Browser-verified: nicht UI-relevant
- [x] Bug reproduced before the fix, gone after: lokal mit nachgestellter
      Inspection-Kette (Electron-als-Node + echte `ws`):
      `SELF_SIGNED_CERT_IN_CHAIN` reproduziert; `NODE_EXTRA_CA_CERTS`-Weg
      verbindet (OPEN); `NODE_USE_SYSTEM_CA=1` erweitert die effektive
      CA-Liste (144 → 156). Der OS-Store-Weg selbst ist auf macOS ohne
      Admin-Rechte nicht end-to-end testbar → BLOCKED, Windows-Feldtest nötig
