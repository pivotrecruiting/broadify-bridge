# Task: Meeting-FrameBus gegen Studio-Reconfigure isolieren (FrameBus-Name-Leak über process.env) (PR F)

## Raw request
Gabriel, 29.9.2026: Meeting in Bridge 0.27.2 bringt keine Grafiken mehr ins Bild. Read-only-Audit (29./30.9., Prod-Log + Code): Der Studio-`GraphicsOutputSupervisor` (neu in 0.27.2) wiederholt eine fehlgeschlagene persistierte Studio-Ausgabe (key_fill_sdi auf nicht angeschlossenem DeckLink) mit Backoff. Während eines Meetings steht `process.env.BRIDGE_FRAMEBUS_NAME` auf dem Meeting-Bus (`bfy-meet-gfx-front`), weil `configureMeetingGraphicsOutputs` die Env explizit setzt und `applyFrameBusSessionConfig`/die Transition-Service für JEDEN Manager `applyFrameBusEnv` aufruft. Der Studio-Singleton hat keine `frameBusOverrides`; `buildFrameBusConfig` löst mit Präzedenz overrides → env → previous → generate den Namen `bfy-meet-gfx-front` auf, sendet `renderer_configure` (50 fps) dorthin → "Stale incompatible FrameBus region found; recreating" → der Studio-Renderer zerstört den Meeting-Front-Bus; Lower Thirds/Overlays verschwinden. Nicht-deterministisch, weil der Rollback in `graphics-output-transition-service.ts` nach jedem fehlgeschlagenen Retry die Env auf die Studio-Config zurücksetzt. Gabriel-Go am 2.10.2026 für diesen Fix (PR F).

## Context
- Customer / project: Broadify Bridge, Graphics FrameBus / Meeting-Grafik
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/framebus-meeting-bus-isolation, feature/framebus-meeting-bus-isolation
- Base branch: dev (573454e5)
- Relevante Dateien (Basis-Zeilen): `apps/bridge/src/services/graphics/framebus/framebus-config.ts` (`buildFrameBusConfig` Z. 66-107, `applyFrameBusEnv` Z. 110-119, `clearFrameBusEnv`), `apps/bridge/src/services/graphics/graphics-framebus-session-service.ts` (`applyFrameBusSessionConfig` Z. 79-88), `apps/bridge/src/services/graphics/graphics-output-transition-service.ts` (`applyAtomic` Z. 98-146: `applyFrameBusEnv(nextFrameBusConfig)` Z. 121; `rollback` Z. 148-175: `applyFrameBusEnv(previous)`/`clearFrameBusEnv()` Z. 163-171), `apps/bridge/src/services/graphics/graphics-manager.ts` (Deps-Aufbau ~Z. 255-265, `applyFrameBusSessionConfig` Z. 286-290, `frameBusOverrides` Z. 130), `apps/bridge/src/services/meeting/meeting-command-handler.ts` (`configureMeetingGraphicsOutputs` Z. 130-185 mit den `process.env.BRIDGE_FRAMEBUS_*`-Sets Z. 147-170), `apps/bridge/src/services/meeting/meeting-graphics-manager.ts` (Meeting-Manager mit `frameBusOverrides`). Tests: `framebus/framebus-config.test.ts`, `graphics-framebus-session-service.test.ts`, `graphics-output-transition-service.test.ts`, `graphics-manager.test.ts`, `services/meeting/meeting-command-handler.test.ts`.

## Plan
1. `framebus-config.ts` `buildFrameBusConfig`: Präzedenz für `name` und `slotCount` auf **overrides → previous → env → generate/default** ändern (ein Manager, der bereits einen Bus besitzt, behält ihn; die Env seeded nur den allerersten Resolve eines Managers ohne Overrides, z. B. ein in `.env` gepinnter Studio-Name). `pixelFormat` unverändert. JSDoc-Kommentar (Englisch) mit dem Grund (Env ist prozessweiter, zwischen Managern geteilter Zustand; Studio-Supervisor-Retry während eines Meetings).
2. `graphics-framebus-session-service.ts` `applyFrameBusSessionConfig`: `applyFrameBusEnv(next)` nur, wenn KEINE `overrides?.name` gesetzt sind (Manager mit eigenem Bus-Namen = Meeting-Planes schreiben die Prozess-Env nicht). Log-Zeile unverändert.
3. `graphics-output-transition-service.ts`: neues Dep `ownsProcessFrameBusEnv: boolean` (Studio-Singleton = true, Manager mit `frameBusOverrides.name` = false; in `graphics-manager.ts` beim Deps-Aufbau aus `!this.deps.frameBusOverrides?.name` ableiten). `applyFrameBusEnv(nextFrameBusConfig)` in `applyAtomic` und `applyFrameBusEnv(previous)`/`clearFrameBusEnv()` im `rollback` nur ausführen, wenn `ownsProcessFrameBusEnv` true ist. Die Output-Helper (DeckLink/Display) lesen die Env nur im Studio-Pfad; Meeting-Manager nutzen `outputKey: "framebus"` ohne Helper.
4. `meeting-command-handler.ts` `configureMeetingGraphicsOutputs`: die Env-Sets bleiben für den Renderer-Spawn (Kind erbt `process.env` beim Start), werden aber mit Save/Restore gekapselt: vor dem ersten Set einen Snapshot von `BRIDGE_FRAMEBUS_NAME`, `BRIDGE_FRAMEBUS_SLOT_COUNT`, `BRIDGE_FRAMEBUS_PIXEL_FORMAT` nehmen und in einem `finally` nach beiden `configureOutputs`-Aufrufen exakt wiederherstellen (fehlende Variablen wieder löschen). Kommentar aktualisieren (Belt-and-braces-Text ersetzen durch die neue Regel).
5. Tests:
   - `framebus-config.test.ts`: (a) env = `bfy-meet-gfx-front`, previous.name = `broadify-framebus-abc`, keine Overrides → Name bleibt `broadify-framebus-abc`; (b) ohne previous → env wird genutzt; (c) Overrides gewinnen weiterhin über previous und env; (d) slotCount analog.
   - `graphics-framebus-session-service.test.ts`: mit `overrides.name` wird `process.env.BRIDGE_FRAMEBUS_NAME` NICHT verändert; ohne Overrides wie bisher gesetzt.
   - `graphics-output-transition-service.test.ts`: `ownsProcessFrameBusEnv: false` → weder `applyAtomic` noch `rollback` schreiben die Env; `true` → bisheriges Verhalten (bestehende Tests anpassen).
   - `graphics-manager.test.ts`: Manager mit `frameBusOverrides` schreibt keine Env; Studio-Singleton-Verhalten unverändert (bestehende Tests müssen grün bleiben).
   - `meeting-command-handler.test.ts`: nach `meeting_graphics_configure_outputs` (bzw. Engine-Start-Pre-Warm) ist `process.env.BRIDGE_FRAMEBUS_NAME` wieder auf dem Vorwert (gesetzt und ungesetzt testen).
   - Regressionsszenario (in `framebus-config.test.ts` oder `graphics-manager.test.ts`): "studio resolve while env points at the meeting front bus keeps its own bus name".
6. Doku: `docs/bridge/architecture/graphics-realtime-framebus.md` (oder `graphics-realtime-architecture.md`, je nachdem wo FrameBus-Namen beschrieben sind) Abschnitt "FrameBus-Name: Präzedenz und Env-Besitz" (overrides → previous → env → generate; nur der Studio-Singleton schreibt die Prozess-Env; Meeting-Planes nutzen Overrides; Hintergrund 0.27.2-Vorfall). `docs/bridge/features/graphics-commands.md` nur anpassen, falls dort die Env-Präzedenz steht.

Konventionen: Code-Kommentare Englisch; keine neuen Dependencies; nur die genannten Dateien; keine Änderung am Supervisor selbst (`graphics-output-supervisor.ts`) und nicht an der Renderer-Entry.

## Acceptance criteria
1. `buildFrameBusConfig` liefert bei vorhandenem `previous` dessen Namen/slotCount, auch wenn `process.env.BRIDGE_FRAMEBUS_NAME` auf einen anderen Bus zeigt; Overrides gewinnen weiterhin; ohne previous greift die Env; ohne beides wird generiert.
2. Manager mit `frameBusOverrides.name` schreiben an keiner Stelle (Session-Service, Transition-Service inkl. Rollback) die `BRIDGE_FRAMEBUS_*`-Env; der Studio-Singleton verhält sich bit-identisch zu heute.
3. `configureMeetingGraphicsOutputs` stellt die drei Env-Variablen nach Abschluss (auch im Fehlerfall) exakt wieder her.
4. Alle genannten Tests existieren und sind grün: `npx jest apps/bridge/src/services/graphics apps/bridge/src/services/meeting/meeting-command-handler.test.ts --runInBand`; `npm run lint` grün.
5. Doku aktualisiert.

## Review
- Round: 1/3
- Verdict: PASS (Verifier 2.10.2026, separater Agent; alle 5 Akzeptanzkriterien PASS)
- Must-fix (open): keine
- Notes (non-blocking):
  1. JSDoc-Reste beschreiben nur "overrides win over env", nicht die neue previous-vor-env-Ordnung (`graphics-framebus-session-service.ts:15,76`, `graphics-manager.ts:123-129`, `meeting-graphics-manager.ts:82-89`).
  2. Restrisiko (Plan-bekannt): ein Studio-Manager ohne `previous` (allererster Resolve) nähme im Meeting-Set-Fenster weiterhin die Meeting-Env als Seed; Fenster ist jetzt auf die zwei `configureOutputs`-Aufrufe begrenzt.
  3. Kosmetik: Leerzeile in `meeting-command-handler.test.ts`.
- Handoff to human (if any): keiner.

## Verification
- [x] Tests pass — `npx jest apps/bridge/src/services/graphics apps/bridge/src/services/meeting/meeting-command-handler.test.ts --runInBand`: 59 suites, 801 tests passed (Verifier)
- [x] Lint / type-check pass — `npm run lint` Exit 0; `tsc --noEmit -p apps/bridge/tsconfig.build.json` Exit 0 (Verifier)
- [x] `npm run build:bridge` Exit 0 (Verifier)
- [x] Regressionstest rot ohne Fix / grün mit Fix — Verifier führte das Szenario gegen die Basis-`framebus-config.ts` aus: `[base] bfy-meet-gfx-front` (RED), `[fixed] broadify-framebus-studio` (GREEN); Implementierer-Lauf: Test vor dem Fix rot, danach 17/17 grün
