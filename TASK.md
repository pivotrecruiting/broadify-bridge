# Task: Keyer-Refine-Plumbing (PR D1): Tier-Cap für Windows-Work-Width, macOS Refine-Budget und Modus-Kopplung, Envs weiterleiten (Defaults unverändert)

## Raw request
Gabriel (Product Owner, 1.10.2026): Keyer-Default anheben (macOS Refine 1920 statt 960, Windows Work-Width höher), aber mit Messung vor dem Default-Flip und Governor-Absicherung. Dieser PR liefert NUR das Plumbing und die Absicherung; die Defaults (960 / 512) bleiben in diesem PR unverändert. Der Flip folgt in D2 nach der Messung.

## Context
- Customer / project: Broadify Bridge, Meeting-Helper Keyer (`apps/bridge/native/meeting-helper/src/keyer`, `src/pipeline`, `src/compose`)
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/keyer-refine-plumbing, feature/keyer-refine-plumbing
- Base branch: dev (573454e5)
- macOS fused CoreML hat KEINEN Governor (Governor-Block ist `#elif defined(_WIN32)` in `pipeline/frame_pipeline.cpp:2615`); Windows hat die Tier-Leiter Full512/Balanced320/Performance256/Lite256/Off (`keyer/keyer_governor.h:14`).

## Plan
Siehe /Users/gabrielbaeuerle/.claude/plans/okay-dann-mache-bitte-linear-sunset.md, Abschnitt "WS4 (PR D1/D2)", Teil D1. Kurzfassung:

1. Allowlist `apps/bridge/src/services/meeting/meeting-helper-manager.ts` (`MEETING_HELPER_FORWARDED_ENV_KEYS`, Z. 74-114): `BROADIFY_MEETING_GPU_REFINE_BUDGET_MS` ergänzen (alphabetisch); Test `meeting-helper-manager.test.ts` (Z. 177-215) erweitern.
2. Windows Work-Width mit Tier-Cap:
   - `apps/bridge/native/meeting-helper/src/pipeline/guided_work_size.{h,cpp}`: neue Funktionen `void setGuidedWorkWidthTierCap(uint32_t cap)` (atomic, 0 = unbegrenzt) und `uint32_t guidedWorkWidth()` = Env-Pin (`BROADIFY_MEETING_MASK_WORK_WIDTH`, wenn gesetzt → gewinnt, A/B-Regel) sonst `min(kDefaultMaskWorkWidth, cap)`; Pure-Function `uint32_t guidedWorkWidthCapForTier(GovernorTier tier)` (Full512 → 0/unbegrenzt, Balanced320 → 640, Performance256/Lite256/Off → 512). `guidedWorkWidthFromEnv()` bleibt für Rückwärtskompatibilität (oder wird auf `guidedWorkWidth()` umgeleitet). Default `kDefaultMaskWorkWidth` bleibt 512.
   - `compose/d3d11_compositor.cpp:1190-1191` und `pipeline/guided_mask_refine.cpp:158-159`: `guidedWorkWidthFromEnv()` → `guidedWorkWidth()`.
   - `pipeline/frame_pipeline.cpp` Windows-Block (ab Z. 2622, `fusedGovernor`): bei Tier-Wechsel `setGuidedWorkWidthTierCap(guidedWorkWidthCapForTier(tier))` setzen (an der Stelle, wo das Tier-Label/`performanceModeForTier` übernommen wird).
3. macOS Refine-Budget und Modus-Kopplung:
   - `keyer/gpu_mask_refine.{h,mm}`: `void setMaxOutputWidth(uint32_t)` (Env-Pin `BROADIFY_MEETING_GPU_REFINE_WIDTH` gewinnt, wenn gesetzt); EMA der `encodeRefine`-Wandzeit (Z. 165-167 misst `waitUntilCompleted` ohnehin); Env `BROADIFY_MEETING_GPU_REFINE_BUDGET_MS` (Default 8.0); liegt die EMA über ≥30 Samples über dem Budget → einmalige, sessionweite Stufe auf 960 (nur wenn aktuell > 960) + eine `emitHelperEvent`-Zeile `{"type":"keyer_refine_stepdown",...}`; kein erneuter Step-up in derselben Session.
   - `keyer/coreml_keyer.mm:69`: den bisher ignorierten `settings`-Parameter nutzen: `settings.performanceMode == "performance"` → `setMaxOutputWidth(960)`, sonst Default (unverändert 960 in diesem PR; D2 hebt den Default auf 1920).
   - Effektive Breite erscheint bereits als `mask_width x mask_height` in den Metriken; zusätzlich `refine_width` im Keyer-Status-JSON (`control/control_server.cpp:225-258`) additiv ausgeben.
4. Tests: `apps/bridge/native/meeting-helper/tests/guided_work_size_test.cpp` (Z. 21-33) um Tier-Caps (Full512 unbegrenzt, Balanced320 → 640, Performance256 → 512) und Env-Pin-Vorrang erweitern; `guided_mask_refine_test.cpp` auf 512-Annahmen prüfen und ggf. anpassen. Jest für die Allowlist.
5. Messprotokoll als Doku: `docs/bridge/dev/meeting-helper-dev-setup.md` neuer Abschnitt "Refine-Width-Messung (vor Default-Flip)": Geräte (Apple Silicon, Intel-Mac, Windows-iGPU), Pins `BROADIFY_MEETING_GPU_REFINE_WIDTH=1920` (mac) / `BROADIFY_MEETING_MASK_WORK_WIDTH=960` (win), 2 min, Gate `program_fps ≥ 29.5`, `program_frame_ms` p95 < 25, `mask_apply_ms` (mac) < 8, `mask_width x mask_height` = 1920x1080 / 960x540, Windows ohne Tier-Wechsel-Events. Außerdem `docs/bridge/features/meeting-keyer-windows.md` (Tier-Cap in der Env-Tabelle) und `docs/bridge/architecture/meeting-keyer-auto-degradation.md` (Work-Width-Spalte in der Tier-Ladder; Zahlen korrigieren: `stepUpFactor` ist 0.8 nicht 0.7, `reprobeMaxInterval` ist 120 s nicht 600 s).

Konventionen: Code-Kommentare Englisch; keine Default-Änderungen (960/512 bleiben); keine Änderungen außerhalb der genannten Dateien; Windows-Code wird lokal nicht kompiliert (CI), daher besonders sorgfältig; macOS-Build + ctest macht der Verifier.

## Acceptance criteria
1. `guidedWorkWidth()` respektiert Env-Pin > Tier-Cap > Default; D3D11- und CPU-Refine nutzen es; der Windows-Governor setzt den Cap bei Tier-Wechsel.
2. macOS: Refine-Breite ist über `setMaxOutputWidth` steuerbar, `performance`-Modus → 960; Budget-Stepdown greift einmalig bei EMA > Budget über ≥30 Samples und emittiert ein Event; Env-Pin gewinnt.
3. Defaults unverändert (macOS 960, Windows 512); Verhalten ohne Envs ist bis auf die neue Metrik identisch.
4. `guided_work_size_test` erweitert und grün; Jest-Allowlist-Test grün; `npm run lint` grün.
5. Doku (Messprotokoll + Korrekturen) vorhanden.

## Review
- Round: 2/3
- Verdict: PASS nach Runde 2 (Runde 1 Verifier 2.10.2026: 1 MUST-FIX; Runde 2 Fix durch Codex, Re-Verifikation durch Orchestrator: `npm run build:meeting-helper` Exit 0, `npm run test:meeting-helper-native` 33/33 passed, `npm run lint` Exit 0).
- Must-fix (open): keine
- Must-fix (resolved):
  1. `gpu_mask_refine.mm` `setMaxOutputWidth(0)` (jeden Frame aus `CoreMLKeyer::apply`) machte den einmaligen Budget-Stepdown still rückgängig. Fix: Stepdown ist jetzt ein sessionweiter Floor (`if (steppedDown_) outWidth_ = min(outWidth_, 960)`); Test `guided_work_size_test` zusätzlich mit Cap 256 → 256.
- Notes (non-blocking):
  1. `refine_width` im Status ist Alias von `mask_width` (effektive Breite), nicht der konfigurierte Zielwert.
  2. EMA misst nur `commit`→`waitUntilCompleted` (GPU), nicht Readback/Upload.
  3. Ungültiger Env-Pin (`abc`/`5000`) gilt als gepinnt (960) und deaktiviert Stepdown/Modus-Kopplung.
  4. Cap wird jeden Frame idempotent gesetzt (nicht nur bei Tier-Wechsel); folgt dem Governor-Tier auch bei Env-Performance-Override.
  5. Test deckte keinen Cap unterhalb des Defaults ab (Runde 2 ergänzt 256 → 256).
  6. "in this PR"-Formulierung in `meeting-keyer-windows.md`.
- Handoff to human (if any): Windows-Compile BLOCKED lokal (statisch keine Befunde) → CI/Windows-Build; Messprotokoll ist Doku-Stand, Ausführung im RC-Feldtest (D2).

## Verification
- [ ] Tests pass (ctest + Jest)
- [ ] Lint / type-check pass
- [ ] `npm run build:meeting-helper && npm run test:meeting-helper-native` (Verifier, macOS)
- [ ] Messprotokoll ausführbar (RC-Feldtest, D2 erst danach)
