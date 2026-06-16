# Bugs Detected — Broadify (Bridge / Relay / WebApp)

> Tracking-Liste der im Code **eindeutig verifizierten** Bugs aus der Connection-Debug-Session.
> Jeder Eintrag: Beschreibung, Beleg (Datei:Zeile), Symptom/Impact, Fix-Ziel.
> Ergänzt [`production-debug-connections-page.md`](./production-debug-connections-page.md).

| Feld | Wert |
| --- | --- |
| **Erstellt** | 2026-06-15 |
| **Repos** | `broadify-bridge`, `broadify-relay`, `broadify` (WebApp) |
| **Status-Legende** | `open` · `in_progress` · `fixed` · `wontfix` |

---

## Übersicht

| # | Severity | Bug | Repo | Status |
| --- | --- | --- | --- | --- |
| [1](#1-macos-local-network-berechtigung-nicht-deklariert) | **Critical** | macOS „Lokales Netzwerk"-Berechtigung nicht deklariert | bridge | `open` |
| [2](#2-relay-async-operation-wird-bei-timeout-nie-freigegeben) | **High** | Relay: async Operation bei Timeout/Disconnect nie freigegeben → dauerhafter „Resource busy"-Lock | relay | `open` |
| [3](#3-netzwerk-interface-erkennung-falsch-auf-macos) | **Medium** | Interface-Erkennung klassifiziert macOS-Interfaces falsch (`en0` = WLAN als Ethernet) | bridge | `open` |
| [4](#4-relay-client-error-handler-stößt-keinen-reconnect-an) | **Medium** | Relay-Client `error`-Handler stößt keinen Reconnect an | bridge | `open` |
| [5](#5-port-checker-false-negative-hebelt-bind-fallback-aus) | **Medium** | `port-checker` false-negative hebelt Bind-Fallback aus | bridge | `open` |
| [6](#6-delivery_timeout-an-signaturprüfung-gekoppelt) | **Medium** | `delivery_timeout` an Signaturprüfung/JWKS-Fetch gekoppelt | bridge | `open` |
| [7](#7-sonstiges--niedrige-priorität) | Low | Secrets in `.env` können in Build gelangen · Doku-Fehler UDP/TCP | bridge | `open` |

---

## 1. macOS „Lokales Netzwerk"-Berechtigung nicht deklariert

**Severity:** Critical · **Status:** `open` · **Repo:** `broadify-bridge`
**Bestätigt als Ursache** des ATEM-Ausfalls am Mac (Kunde hat Haken in Systemeinstellungen gesetzt → ATEM lief wieder).

**Beschreibung**
Seit macOS Sonoma/Sequoia braucht jede App eine Nutzerfreigabe für LAN-Zugriff. Ohne Freigabe wird LAN-Traffic (ATEM UDP `:9910`) lautlos verworfen → `Connection timeout`. Die WS-Verbindung zum Relay (öffentliche Adresse `broadify-relay.fly.dev`) ist nicht betroffen → „Bridge verbindet mit WebApp, aber kein ATEM". Windows kennt diese Berechtigung nicht → dort kein Problem.

**Beleg**
- `build/entitlements.mac.plist` — enthält **keine** Netzwerk-/Local-Network-Deklaration.
- `electron-builder.json` / `electron-builder.config.cjs` — setzen **kein** `NSLocalNetworkUsageDescription` (kein `extendInfo`).
- `electron-builder.config.cjs:27` — RC-Build hat eigene Bundle-ID `com.broadify.bridge.rc` ≠ Release `com.broadify.bridge` → macOS behandelt sie als **getrennte Apps**, jede braucht **eigene** Local-Network-Freigabe (RC↔Release-Wechsel setzt Berechtigung zurück → „mal geht's, mal tagelang nicht").

**Impact**
LAN-Geräte (ATEM) am Mac nicht erreichbar, obwohl Netzwerk/Ping ok. Selbstheilung nur durch manuelle Freigabe.

**Fix-Ziel**
- `NSLocalNetworkUsageDescription` (Klartext-Begründung) via `extendInfo`/Info.plist setzen, damit der Berechtigungs-Dialog zuverlässig erscheint.
- Ggf. `com.apple.security.network.client` in den Entitlements ergänzen.
- In der UI/Onboarding einen Hinweis + Deep-Link zu „Systemeinstellungen → Datenschutz → Lokales Netzwerk" zeigen, wenn Engine-Connect mit Timeout fehlschlägt.
- RC↔Release-Bundle-ID-Caveat dokumentieren.

---

## 2. Relay: async Operation wird bei Timeout/Disconnect nie freigegeben

**Severity:** High · **Status:** `open` · **Repo:** `broadify-relay`

**Beschreibung**
Bei async-Commands setzt der Execution-Timeout den Status auf `timed_out_pending`, ruft aber **weder `releaseActiveOperation`** auf **noch setzt er `completedAt`**. Folgen:
1. `activeOperationsByBridgeAndConcurrency[bridgeId:concurrencyKey]` zeigt weiter auf die Operation → jeder weitere Command für dieselbe Ressource bekommt **„Resource is busy" / `operation_in_progress`**.
2. `pruneCompletedOperations` entfernt sie **nie** (überspringt Einträge ohne `completedAt`).
3. Sie wird persistiert und beim **Relay-Restart als „active" wieder geladen** → überlebt sogar Relay-Neustart.

Freigegeben wird der Lock **nur**, wenn die Bridge ein `operation_result` für **genau diese operationId** sendet — was nach Bridge-Restart (neue Session, alte operationId existiert nicht mehr) nie passiert. `deregisterBridge` räumt aktive Operationen **nicht** auf.

**Beleg**
- `src/index.ts:972-1003` — `armOperationTimeout`: setzt `timed_out_pending`, kein `releaseActiveOperation`, kein `completedAt`.
- `src/index.ts:962-970` + `:3050` — `releaseActiveOperation` hat **nur einen** Aufrufer (im `operation_result`-Handler).
- `src/index.ts:1005-1018` — Prune verlangt `completedAt` (Zeile 1008).
- `src/index.ts:1719-1731` — `deregisterBridge` räumt `activeOperationsByBridgeAndConcurrency` / `operations` nicht auf.
- `src/index.ts:2128-2145` — Restart-Reload re-armiert `timed_out_pending` als aktiv.
- Betroffen: async-Commands (`executionMode: "async"`), z.B. `engine_vmix_ensure_browser_input`, `meeting.*` (`command-timeouts.ts`). **Nicht** `engine_connect` (ist `sync`).

**Impact**
Eine einmal hängengebliebene async-Operation sperrt die Ressource (`engine`/`graphics`/`meeting.*`) der Bridge **dauerhaft** — übersteht Bridge- und Relay-Neustart. Passt zum Muster „funktioniert tagelang, dann tagelang nicht" für vMix/Meeting-Flows.

**Fix-Ziel**
- Im Operation-Timeout `releaseActiveOperation(current)` aufrufen und einen terminalen Zustand + `completedAt` setzen (damit Prune greift) — oder `timed_out_pending` in Prune mit eigener Retention berücksichtigen.
- In `deregisterBridge` aktive Operationen + Locks der Bridge freigeben.
- Restart-Reload: `timed_out_pending` mit Alters-/Retention-Grenze laden, nicht unbegrenzt re-armieren.
- Regressionstest: async-Operation Timeout → Folge-Command darf nicht „Resource busy" liefern.

---

## 3. Netzwerk-Interface-Erkennung falsch auf macOS

**Severity:** Medium · **Status:** `open` · **Repo:** `broadify-bridge`

**Beschreibung**
Der „ethernet"-Matcher nutzt `lowerName.includes("en")` → matcht auf macOS auch `en0` (typischerweise **WLAN**). Der „wifi"-Matcher prüft nur `wifi`/`wlan`/`wi-fi`/`wireless` → matcht **kein** echtes macOS-Interface (macOS nutzt nie `wlan0`). Dadurch kann WLAN als Ethernet gewählt und der WLAN-Pfad komplett verfehlt werden.

**Beleg**
- `src/electron/services/network-interface-detector.ts:126-140` und `:289-301` — fehlerhafte Klassifizierung.
- `src/electron/main.ts:431` — resolved Host wird direkt als Bind-Host übernommen.
- `src/electron/services/network-interface-detector.test.ts:21` — Tests nutzen idealisierte Namen (`Wi-Fi`, `wlan0`), decken den macOS-Fall (`en0`) nicht ab.

**Impact**
Lokaler **Bridge-HTTP-Server** kann auf falsche/stale IP binden (z.B. nach DHCP-/Interface-Wechsel) → direkter LAN-Zugriff auf die Bridge bricht.
**Hinweis:** Betrifft **nicht** ATEM (UDP nutzt OS-Routing, kein lokaler Bind in `atem-adapter.ts:181`) und **nicht** HDMI-Erkennung.

**Fix-Ziel**
- Saubere Interface-Klassifizierung auf macOS (Service-Order via `networksetup`/`route get default`, oder korrekte Heuristik statt `includes("en")`).
- macOS-Testfälle mit realen Namen (`en0`, `en1`, `bridge0`, `utun*`) ergänzen.

---

## 4. Relay-Client `error`-Handler stößt keinen Reconnect an

**Severity:** Medium · **Status:** `open` · **Repo:** `broadify-bridge`

**Beschreibung**
Im `error`-Handler des Relay-WebSockets wird nur geloggt und Timer werden gelöscht; `ws` bleibt bestehen, **kein** `scheduleReconnect`. Reconnect läuft nur über den `close`-Handler. Falls `error` ohne sauberes `close` feuert (z.B. Fehler im Connect-Handshake vor `open`), bleibt die Bridge offline bis zum Neustart.

**Beleg**
- `apps/bridge/src/services/relay-client.ts:1189-1194` — `error`-Handler: nur Logging + Cleanup, kein Reconnect.
- `apps/bridge/src/services/relay-client.ts:1163-1187` — `close`-Handler ruft `scheduleReconnect`.
- `apps/bridge/src/services/relay-client.test.ts:1380` — Test erwartet bei `error` nur Logging (bestätigt fehlenden Reconnect).

**Impact**
Latenter „stuck offline bis Neustart"-Zustand. Aktuell nicht das Hauptsymptom (Verbindung klappt), aber Robustheitslücke.

**Fix-Ziel**
- Im `error`-Handler ebenfalls `scheduleReconnect` aufrufen (idempotent mit `close`, doppelte Reconnects vermeiden).
- Test entsprechend anpassen.

---

## 5. `port-checker` false-negative hebelt Bind-Fallback aus

**Severity:** Medium · **Status:** `open` · **Repo:** `broadify-bridge`

**Beschreibung**
`isPortAvailable()` gibt bei **jedem** Fehler `false` zurück, nicht nur bei `EADDRINUSE`. Ein ungültiger/staler Bind-Host (z.B. `EADDRNOTAVAIL` nach IP-Wechsel) wird so als „Port belegt" interpretiert. `BridgeProcessManager.start()` sucht dann nur andere Ports auf demselben (ungültigen) Host. Der eigentliche, sinnvolle Fallback auf `0.0.0.0` im Server wird nie erreicht.

**Beleg**
- `src/electron/services/port-checker.ts:35` — `false` bei jedem Fehler.
- `src/electron/services/bridge-process-manager.ts:98` — interpretiert das als „Port nicht verfügbar".
- `apps/bridge/src/server.ts:213-220` — `EADDRNOTAVAIL` → `0.0.0.0`-Fallback (wird ausgehebelt).

**Impact**
Nach Interface-/IP-Wechsel kann der Bridge-Start auf ungültigem Host hängen statt auf `0.0.0.0` zurückzufallen. Plausibler Auslöser nach Netzwerkwechseln.

**Fix-Ziel**
- In `isPortAvailable` zwischen `EADDRINUSE` (Port belegt) und `EADDRNOTAVAIL`/sonstigen (Host ungültig) unterscheiden.
- Bei ungültigem Host Host-Fallback (`0.0.0.0`) statt nur Port-Suche zulassen.

---

## 6. `delivery_timeout` an Signaturprüfung gekoppelt

**Severity:** Medium · **Status:** `open` · **Repo:** `broadify-bridge`

**Beschreibung**
Die Bridge sendet `command_received` (ACK) erst **nach** `await verifySignedCommand`. Die Verifikation holt bei unbekanntem `kid` per `fetch` die JWKS. Ein kalter/langsamer JWKS-Fetch kann das 2s-ACK-Fenster des Relays reißen → `delivery_timeout`, obwohl der Command angekommen ist. Bei `kid`-Mismatch (z.B. Dev-JWKS gegen Prod-Relay) werden Commands ganz abgelehnt.

**Beleg**
- `apps/bridge/src/services/relay-client.ts:1339` — `await this.verifySignedCommand(message)` vor ACK.
- `apps/bridge/src/services/relay-client.ts:1446-1452` — `command_received` erst danach.
- Relay-ACK-Timeout `delivery_timeout` (`timeoutClass: "fast"` ~2s): `broadify-relay/src/index.ts:2467`.

**Impact**
Sporadische `delivery_timeout` direkt nach (Re)Connect bzw. erstem Command pro `kid`.

**Fix-Ziel**
- `command_received` **vor** bzw. unabhängig von der Signaturprüfung senden (ACK = „empfangen", nicht „validiert").
- JWKS beim Connect vorwärmen (pre-fetch), damit der erste Command nicht blockiert.

---

## 7. Sonstiges / niedrige Priorität

**Severity:** Low · **Status:** `open` · **Repo:** `broadify-bridge`

- **Secrets können in Build gelangen:** `.env` enthält echte Secrets (GitHub-PAT, Apple-Key, Azure-Secret). Da `apps/bridge/dist` komplett ins Package kopiert wird (`electron-builder.json` `extraResources`), kann eine versehentlich dort liegende `.env` mit ausgeliefert werden.
  **Fix-Ziel:** Build-Check, der sicherstellt, dass keine `.env`/Secrets in `dist/` bzw. im Artefakt landen; PAT/Keys bei Gelegenheit rotieren.
- **Doku-Fehler UDP vs. TCP:** `docs/bridge/bridge-architecture.md` beschreibt Engine-Verbindung fälschlich als „TCP" — ATEM nutzt UDP `:9910`.
  **Fix-Ziel:** Doku auf UDP (ATEM) vs. HTTP (vMix/TriCaster) korrigieren.

---

## Beobachtungen / Architektur-Risiken (kein eindeutiger Bug)

> Nicht als Bug klassifiziert — der Vollständigkeit halber festgehalten.

- **Relay Multi-Instanz-Routing:** Prod läuft mit `min_machines_running = 2` (`fly.prod.toml`); Bridges liegen in-memory pro Maschine (`index.ts:755`). Cross-Instance-Routing via `fly-prefer-instance-id` (WebApp) + `fly-replay` (Relay) hängt an der Frische der Supabase-Tabelle `relay_bridge_sessions`. Bei ungrazilen Disconnects (Laptop-Schlaf/WLAN) bis zu `RELAY_SESSION_MAX_AGE_MS = 120s` Fehlrouting möglich. Session-Guards selbst sind korrekt. → Mehr Observability (Misrouting-Logging) sinnvoll.
- **Relay-Ressourcen:** 256 MB / 1 CPU pro Maschine (`fly.prod.toml`) ist knapp für Node + viele WS + In-Memory-Maps; GC-Pausen können vereinzelt enge Timeouts reißen.
- **HDMI/Output-Erkennung Mac:** läuft über `system_profiler SPDisplaysDataType` (`apps/bridge/src/modules/display/display-module.ts`). Falls weiter Probleme: echten Mac-Bridge-Log (`[Display]`/`list_outputs`) prüfen (Timeout/Parsing/neuere macOS-Version).

---

## Changelog

| Datum | Änderung |
| --- | --- |
| 2026-06-15 | Initiale Liste: Bugs 1–7 aus Connection-Debug-Session |
