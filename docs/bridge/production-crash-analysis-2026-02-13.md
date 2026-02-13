# Production Crash Analyse (Stand: 13.02.2026)

## Scope
- Verglichene Inputs: bereitgestellte Dev-Logs und Production-Logs (Electron + Bridge Start, Output-Konfiguration, 1x `graphics_send`).
- Zusätzlich geprüft: Renderer/FrameBus/Bridge-Prozess-Code sowie Release-/Packaging-Dateien (`electron-builder.json`, `.github/workflows/release.yml`, `.github/workflows/test-release.yml`, Build-Skripte).
- Hinweis aus dem Ticket berücksichtigt: Ursache ist nicht primär „HDMI/Display/SDI als fachliche Auswahl“.

## Kurzfazit
- Der direkte Crash passiert im **Graphics-Renderer-Prozess** (`renderer_error ... signal SIGSEGV`), nicht im Bridge-Hauptprozess.
- Die stärkste technische Ursache ist ein **Native-Lifecycle-Fehler im FrameBus-Addon** bei `close()` (Double-Finalize-Risiko), der im Production-Flow getriggert wird.
- Dev und Production laufen in unterschiedlichen Runtime-Pfaden; der kritische Pfad (persistierte Config + Reconfigure vor erstem Send) war in deinen Dev-Logs nicht aktiv.

## Dev vs Production: Relevante Abweichungen

| Bereich | Dev | Production | Bewertung |
|---|---|---|---|
| Bridge Runtime | `NODE_ENV=development`, Node-Start lokal | `NODE_ENV=production`, Bridge via Electron-Binary mit `ELECTRON_RUN_AS_NODE=1` | Architekturbedingt anders, relevant für Spawn-/Native-Verhalten |
| Renderer-Binary | `node_modules/.bin/electron` | `/Applications/Broadify Bridge.app/Contents/MacOS/Broadify Bridge` | Anderer Executable-Pfad/Packaging-Kontext |
| Persistierte Output-Config beim Start | teils fehlend/invalid (`ENOENT`) | vorhanden, initial FrameBus `1920x1080@25` | Production geht in zusätzlichen Reconfigure-Pfad |
| Reconfigure vor erstem Render | in Dev-Run nicht sichtbar | ja: vor `graphics_send` Wechsel auf `1920x1080@50` | triggert `frameBusWriter.close()` + Neuerstellung |
| Crashzeitpunkt | kein Crash | nach `First paint` + kurz nach erstem DeckLink-Frame, dann `SIGSEGV` | passt zu Native-Use-After-Free/Double-Finalize-Hypothese |
| Zusätzliche Prod-Only Logs | keine `dotenv`-Inject-Line | `dotenv` lädt aus `Application Support/.../.env` | Umgebungsdrift möglich |
| UserData Namespace | `electron-vite-template` | ebenfalls `electron-vite-template` | Dev/Prod-Zustand kann sich gegenseitig beeinflussen |

## Priorisierte Liste möglicher Fehler

## P0 (höchste Priorität): FrameBus-Addon `close()` kann Handle doppelt freigeben

**Warum hochrelevant**
- In `apps/bridge/native/framebus/src/framebus-addon.cc:174` wird in `WriterClose` direkt `FinalizeHandle(...)` aufgerufen.
- Danach wird mit `napi_wrap(..., nullptr, ...)` „zurückgesetzt“ (`apps/bridge/native/framebus/src/framebus-addon.cc:185`), ohne Statusprüfung.
- Das ist als „Unwrap/Detach“ unsicher; bei späterer GC-Finalization kann das bereits freigegebene Handle erneut finalisiert werden.

**Korrelation mit deinen Logs**
- Production hat initial FrameBus `...fps:25` und danach Reconfigure auf `...fps:50`.
- Dieser Wechsel erzwingt `frameBusWriter.close()` in `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:256`.
- Genau danach kommt der erste Paint/Frame und kurz darauf `SIGSEGV` im Renderer-Prozess.
- Dev-Run zeigt den kritischen Close-Recreate-Pfad vor dem ersten Send nicht in gleicher Form.

**Code-Belege**
- `apps/bridge/native/framebus/src/framebus-addon.cc:174`
- `apps/bridge/native/framebus/src/framebus-addon.cc:185`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:236`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:256`

## P1: Offscreen-Renderer-Crash im packaged Runtime-Kontext (GPU/Sandbox/Chromium)

**Warum relevant**
- Crash kommt direkt nach `First paint`.
- Renderer läuft als offscreen `BrowserWindow` mit `sandbox: true` im Production-Binary.
- Es gibt bereits einen expliziten Schalter für GPU-Deaktivierung (`BRIDGE_GRAPHICS_DISABLE_GPU`), was typisch für bekannte plattformabhängige Offscreen-Probleme ist.

**Code-Belege**
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:27`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:52`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:442`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:453`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts:460`

## P1: Aux-Mode lädt Desktop-Env auch im Renderer-Subprozess

**Warum relevant**
- Renderer-Subprozess läuft über `src/electron/main.ts` im Aux-Mode.
- Bereits beim Import von `util.ts` wird `loadAppEnv()` ausgeführt.
- In Production-Log sichtbar: `dotenv` lädt aus UserData-`.env`.
- Damit sind versteckte Env-Differenzen zwischen Kundenmaschinen möglich.

**Code-Belege**
- `src/electron/main.ts:109`
- `src/electron/main.ts:114`
- `src/electron/util.ts:7`
- `src/electron/services/env-loader.ts:23`
- `src/electron/services/env-loader.ts:77`

## P2: Persistierte Output-Konfiguration erzeugt zusätzlichen, nicht-dev-äquivalenten Startup-Pfad

**Warum relevant**
- Bei Start wird persistierte Output-Config geladen und direkt angewendet.
- Danach kommt im Runtime-Betrieb häufig erneut `graphics_configure_outputs`.
- Dadurch entstehen zusätzliche Übergänge (Renderer configure, Adapterwechsel, FrameBus-Recreate), die lokal oft nicht exakt reproduziert werden.

**Code-Belege**
- `apps/bridge/src/services/graphics/output-config-store.ts:25`
- `apps/bridge/src/services/graphics/graphics-runtime-init-service.ts:70`
- `apps/bridge/src/services/graphics/graphics-output-transition-service.ts:98`

## P2: Dev/Prod teilen denselben UserData-Namespace (`electron-vite-template`)

**Warum relevant**
- Package-Name/App-ID sind Template-basiert.
- Dev und Production nutzen dadurch denselben Application-Support-Bereich.
- Stale `.env`/Output-Config kann zu nicht reproduzierbaren Zustandsunterschieden führen.

**Code-Belege**
- `package.json:2`
- `electron-builder.json:2`

## P3: FrameBus-Größenwarnung im DeckLink-Helper

**Beobachtung**
- Production-Log enthält `FrameBus size mismatch (tolerated)...`.
- Aktuell wird das toleriert; in den gezeigten Logs kein direkter Crashbeleg daraus.

**Code-Beleg**
- `apps/bridge/native/decklink-helper/src/decklink-helper.cpp:1971`

## Release/YAML Analyse (explizit geprüft)
- Mac-Release baut mit Node `22` (`.github/workflows/release.yml:49`) und `build-framebus.sh` targetet korrekt Electron-Header (`scripts/build-framebus.sh:20`).
- Kein offensichtlicher YAML-Fehler gefunden, der den gezeigten SIGSEGV direkt erklärt.
- Relevanter ist die Runtime-Diskrepanz „packaged Binary + persistierter Config-Pfad + Native close/recreate“.

## Empfohlene Verifikation in Reihenfolge
1. P0 verifizieren: Testbuild mit sicherem `close`-Lifecycle im FrameBus-Addon (sauberes `napi_remove_wrap`/idempotentes Finalize) und identischer Kunden-Sequenz (persistiert 25fps, dann configure 50fps, dann `graphics_send`).
2. P1 isolieren: gleicher Test mit `BRIDGE_GRAPHICS_DISABLE_GPU=1`.
3. P2 isolieren: Kundenlauf einmal mit geleertem UserData-`graphics-output.json` und ohne UserData-`.env`.
4. Wenn danach weiterhin Crash: Native Crash-Report des Renderer-Prozesses (symbolicated) auf FrameBus-Addon vs Chromium-Renderthread differenzieren.

