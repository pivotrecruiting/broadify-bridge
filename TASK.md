# Task: 2x Supersampling für Meeting-Grafik-Planes bei 1080p, nativer Downscale, Windows-Clamp-Fallback (PR B)

## Raw request
Gabriel (Product Owner, 1.10.2026): Meeting-Grafiken (Lower Thirds, Logos, Slides) sollen "wirklich in 1080p" sauber ankommen. Befund: Der Electron-Offscreen-Renderer rastert die Meeting-Planes bei 1920x1080 mit Render-Scale 1 (Supersampling nur bis 1280x720), Downscale läuft in reinen JS-Schleifen.

## Context
- Customer / project: Broadify Bridge, Graphics-Renderer (Electron offscreen), Meeting-Planes `bfy-meet-gfx-back` / `bfy-meet-gfx-front`
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-graphics-supersample, feature/meeting-graphics-supersample
- Base branch: dev (573454e5)
- Studio-Renderer (1080p50/60) darf sich NICHT ändern (Scale 1 bleibt).

## Plan
Siehe /Users/gabrielbaeuerle/.claude/plans/okay-dann-mache-bitte-linear-sunset.md, Abschnitt "WS2 (PR B)". Kurzfassung:

Dateien: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts` (+ `.test.ts`), `apps/bridge/src/services/graphics/renderer/perf-logging.ts` (+ `.test.ts`), Doku.

1. `resolveRenderScale(width, height, meetingBus: boolean, clampFallback: boolean)` (heute Z. 255-263), Reihenfolge:
   a. Env `BRIDGE_GRAPHICS_SUPERSAMPLE` explizit gesetzt → 1..3 wie heute (globaler Vertrag, auch globaler Kill-Switch).
   b. `clampFallback` → 1.
   c. `meetingBus && width*height <= 1920*1080` → Env `BRIDGE_GRAPHICS_MEETING_SUPERSAMPLE` (Default 2; `0`/`1` deaktiviert; Clamp 1..3).
   d. sonst bestehende Regel (≤1280x720 → 2, sonst 1).
   Aufruf in `ensureSingleWindow` (Z. 1085) mit `isMeetingGraphicsBus()`; der Format-Mismatch-Vergleich (Z. 1088-1105) enthält `renderScale` bereits.
2. Neuer Helper `captureImageToRgba(image, width, height): { buffer: Buffer; resizePath: "native" | "js" } | null`, genutzt im Paint-Handler (Z. 1176-1197) UND in `writeCapturedWindowFrame` (Z. 1475-1497): bei `image.getSize() != target` und vorhandener `image.resize`-Funktion → `image.resize({ width, height, quality: "best" })` → `bgraToRgba(resized.toBitmap())`; ist `resize` nicht vorhanden oder die Ergebnisgröße falsch → bestehender `normalizeCapturedRgbaFrame`-Pfad (JS-Fallback). `toBitmap()` darf nie auf dem großen Bild laufen, wenn `resize` verfügbar ist.
3. `resizePath` und `renderScale` in das Log "First FrameBus frame written" (Z. 1236-1256) und in die Perf-Zeile (`perf-logging.ts`) aufnehmen.
4. Clamp-Fallback: `ensureWindowContentSize` (Z. 904-954) gibt `boolean` zurück (Content passt). In `ensureSingleWindow` nach dem Aufruf: passt der Content nicht und `renderScale > 1` → Modul-Flag `supersampleClampFallback = true`, `logger.warn(..., "[GraphicsRenderer] Supersampling disabled after work-area clamp")`, `destroySingleWindow()` und GENAU EIN Retry; Flag-Reset nur in `applyRendererConfig` bei Formatwechsel (nicht in `destroySingleWindow`, damit der Recover-Pfad Z. 1027 es behält). Bleibt es bei Scale 1 geklemmt, greift der bestehende Error-Log.
5. NICHT ändern: `electron-renderer-dom-runtime.ts`, `layout-runtime.ts`, `graphics-pixel-utils.ts` (bleibt Fallback), Alpha-Semantik.
6. Tests `electron-renderer-entry.test.ts`: Image-Mocks (Z. 2620-2622, 2738-2740, 2790-2797) um `resize: jest.fn(({width,height}) => ({ getSize, isEmpty, toBitmap: () => Buffer.alloc(width*height*4, fill) }))` erweitern, plus Variante ohne `resize` für den JS-Fallback. Neue Tests:
   - "meeting bus at 1080p supersamples 2x and downsamples natively": Bus `bfy-meet-gfx-back`, BrowserWindow 3840x2160, Paint 3840x2160 → `resize` mit `{width:1920,height:1080,quality:"best"}`, `writeFrame`-Buffer 1920*1080*4, Log `renderScale: 2`, `resizePath: "native"`.
   - "studio 1080p keeps scale 1": bestehender Test Z. 4021 bleibt grün, zusätzlich `renderScale: 1` asserten.
   - "falls back to scale 1 when Windows clamps the supersampled window": Meeting-Bus, `mockGetContentSize` liefert `[1920,1032]` → zweiter `BrowserWindow`-Aufruf mit 1920x1080 + Warn-Log.
   - `BRIDGE_GRAPHICS_MEETING_SUPERSAMPLE=1` deaktiviert; `BRIDGE_GRAPHICS_SUPERSAMPLE=1` gewinnt global.
   - JS-Fallback, wenn `resize` fehlt.
   Bestehende Tests Z. 2912/2937/3640 bleiben unverändert grün. `perf-logging.test.ts` um das neue Feld ergänzen.
7. Doku: `docs/bridge/architecture/graphics-realtime-renderer.md` neuer Abschnitt "Supersampling & Capture-Downscale" (Regeln, Envs, nativer Resize, Clamp-Fallback); `docs/bridge/features/meeting-windows-performance.md` Hinweis auf zusätzliche GPU-Last der 4K-Offscreen-Back-Plane.

Konventionen: Code-Kommentare Englisch; keine neuen Dependencies; keine Änderungen außerhalb der genannten Dateien.

## Acceptance criteria
1. Meeting-Bus bei 1920x1080 → BrowserWindow 3840x2160, `renderScale: 2`; Studio-Bus bei 1920x1080 → 1920x1080, `renderScale: 1`; 720p-Regel unverändert.
2. Env-Vorrang: `BRIDGE_GRAPHICS_SUPERSAMPLE` global vor `BRIDGE_GRAPHICS_MEETING_SUPERSAMPLE` (Default 2, `0`/`1` aus).
3. Paint- und Capture-Pfad skalieren per `NativeImage.resize({quality:"best"})` und fallen ohne `resize` auf den JS-Pfad zurück; `resizePath` wird geloggt.
4. Windows-Clamp bei Scale 2 → genau ein Neuaufbau mit Scale 1 + Warn-Log; Clamp bei Scale 1 → bestehendes Verhalten.
5. `npx jest apps/bridge/src/services/graphics/renderer --runInBand` grün; `npm run lint` grün für geänderte Dateien.
6. Doku aktualisiert.

## Review
- Round: 1/3
- Verdict: PASS (Verifier 2.10.2026, separater Agent; alle 6 Akzeptanzkriterien PASS)
- Must-fix (open): keine
- Notes (non-blocking):
  1. Globaler Override `BRIDGE_GRAPHICS_SUPERSAMPLE=2|3` + Windows-Clamp: Retry baut mit gleichem Scale neu, Warn-Text "Supersampling disabled" dann irreführend, "still clamped"-Error im 2. Versuch unterdrückt (`logClampedError = renderScale === 1`). Follow-up: `logClampedError: renderScale === 1 || supersampleClampFallback`.
  2. Diagnose reduziert: "Source frame buffer length mismatch"-Warnungen entfallen; Exception aus `normalizeCapturedRgbaFrame` wird ohne `message` geschluckt. Follow-up: Message ins "Frame downsample failed"-Log.
  3. `buildPerfLogFields` ist Identität, Perf-Zeile selbst nicht getestet; `perfLastResizePath` startet mit "native".
  4. Bestehender Test "paint handler logs buffer length mismatch when toBitmap size wrong" wurde an den neuen Helper angepasst (im Implementierer-Bericht nicht als Abweichung genannt).
  5. `BRIDGE_GRAPHICS_SUPERSAMPLE=0` ist jetzt Kill-Switch (1) statt Default-Regel; entspricht Spec.
- Handoff to human (if any): Live-Kriterium (renderScale 2 / resizePath native, Perf-Gate C0) nur im RC-Feldtest prüfbar.

## Verification
- [x] Tests pass — `npx jest apps/bridge/src/services/graphics/renderer --runInBand`: 18 suites, 251 tests passed (Verifier)
- [x] Lint / type-check pass — `npm run lint` Exit 0; `tsc --noEmit` für `tsconfig.build.json` und `tsconfig-graphics-renderer.json` Exit 0 (Verifier)
- [ ] `npm run build:graphics-renderer` + `npm run build:bridge` (Orchestrator, läuft)
- [ ] Live: "First FrameBus frame written" zeigt `renderScale: 2`, `resizePath: "native"` auf `bfy-meet-gfx-front` (RC-Feldtest)
