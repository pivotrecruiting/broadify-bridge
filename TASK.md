# Task: Windows keyer governor sheds model resolution only when it helps; fused pin fix; stage timings

## Raw request
Gabriel (founder), 2026-10-17, RC v0.27.3-rc.6 on his Windows laptop (GTX 1660 Ti): the keyer cuts parts of
the person away. He approved building these fixes and merging into `dev` for the next RC (not main, not prod).
"Extrem sauber arbeiten, keine Annahmen treffen."

Evidence from his `meeting-helper-events.log` (tier, ms):
- `keyer_budget_overrun`: program_frame_ms 33-45, session_run_ms 10.4-12.6 (one spike 25.7), tensor_ms 1.8-4.5,
  camera_upload_ms 0.4-0.7, tier balanced320/performance256, cadence_n 1-2.
- `keyer_policy_change` shows the governor stepping balanced -> performance after overruns.
So ~20-30 ms per program frame are spent outside the model. On sustained program overrun the frame pipeline calls
`KeyerAutoGovernor::noteProgramBudgetOverrun()` (frame_pipeline.cpp ~2805-2810, keyer_governor.cpp:333-343),
which steps one fused tier down UNCONDITIONALLY, although the model is not the cause and the lower tier barely
saves time (320 vs 256 cost the same on his machine). The lower tier then cuts more of the person.
Once at 256, `estimatedStepUpMs()` scales the EMA by pixel area (x1.5625 for 256->320), which with the
overhead-reduced threshold never fits, so the tier never recovers.
Separately, the env pin `BROADIFY_MEETING_KEYER_PERFORMANCE` is ignored by the fused path: frame_pipeline.cpp
~2184 sets `keyerSettings.performanceMode = state.performanceMode` (webapp "balanced"), ~2845-2847 only skips the
governor when the pin is active but never applies the pin value (the async path applies it in keyer_chain.cpp:145-148).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/keyer-win-governor-telemetry, feature/keyer-win-governor-telemetry
- Base branch: dev (d458791f, version 0.27.3-rc.6)
- Code root: apps/bridge/native/meeting-helper/
- A parallel branch (feature/keyer-win-fill-input) changes only src/keyer/matting_common.*, modnet_keyer.cpp,
  openvino_keyer.cpp, dml_device_input.*; do not touch those files here. Tensor shapes stay square 512/320/256.

## Plan
A. Overrun step-down only when the lower tier can bring the frame into budget (`src/keyer/keyer_governor.h/.cpp`)
   1. In `seedMeasuredProbes(full512Ms, balanced320Ms, performance256Ms)` store the three probes in new members
      (`probe512Ms_`, `probe320Ms_`, `probe256Ms_`), including when they are <= 0 (meaning "unknown"). Store them
      before the existing early-return conditions only if the governor is not yet seeded (same guard as today), and
      clear them in `reset()`. `seedProbe()` does not set them.
   2. Add a private helper `double sessionCostRatio(GovernorTier from, GovernorTier to) const`:
      - `area = areaScale(to) / areaScale(from)`.
      - If both tiers are fused tiers with a stored probe > 0: `ratio = probe(to) / probe(from)`.
        For a step DOWN (to cheaper tier) clamp to `[area, 1.0]`; for a step UP clamp to `[1.0, area]`.
      - Otherwise return `area` (today's assumption, unchanged behavior when probes are unknown).
   3. Add `struct ProgramOverrunSample { double programFrameEmaMs; double budgetMs; double sessionRunMs; double tensorMs; };`
      and `enum class OverrunDecision { Ignored, SteppedDown, NotTierBound };` plus
      `struct OverrunOutcome { OverrunDecision decision; double estimatedSavingsMs; double projectedMs; };`.
   4. Add `OverrunOutcome noteProgramBudgetOverrun(TimePoint now, const ProgramOverrunSample &sample)`:
      - Not seeded, or tier not Full512/Balanced320 -> `Ignored` (no state change), as today.
      - `target = availableTierBelow(tier_)`. If `target` is not a fused tier -> keep today's behavior
        (`stepDown(target)`, `SteppedDown`).
      - If `sample.programFrameEmaMs <= 0`, `sample.budgetMs <= 0` or `sample.sessionRunMs <= 0` -> today's behavior
        (`stepDown(target)`, `SteppedDown`, savings/projected = -1).
      - `savings = sessionRunMs * (1 - sessionCostRatio(tier_, target)) + max(0, tensorMs) * (1 - area(target)/area(tier_))`;
        `projected = programFrameEmaMs - savings`.
      - `projected <= budgetMs` -> `stepDown(target)`, `SteppedDown`; else `NotTierBound` and NO state change
        (do not reset EMA, samples, clocks or watches).
      - Keep the existing `noteProgramBudgetOverrun(TimePoint now)` unchanged (unconditional step-down); it is the
        "always" mode and existing tests use it.
   5. `estimatedStepUpMs()`: replace `emaMs_ * (areaScale(target) / areaScale(tier_))` by
      `emaMs_ * sessionCostRatio(tier_, target)` (falls back to the area ratio when probes are unknown, so existing
      behavior and tests without probes stay identical). The Lite256 -> Performance256 path keeps using the EMA
      directly (ratio 1.0, same input size) — verify `sessionCostRatio(Lite256, Performance256)` returns 1.0, or
      keep that path as it is today.
B. Frame pipeline wiring (`src/pipeline/frame_pipeline.cpp`, Windows fused path)
   1. Where the overrun event sets `fusedProgramOverrunPending = true` (~3533-3538), also store a
      `ProgramOverrunSample` taken from the SAME frame: `programFrameEmaMs = fusedBudgetOverrunReporter.emaMs()`,
      `budgetMs = fusedReporterBudgetMs`, `sessionRunMs = fusedInferenceSessionRunMs`, `tensorMs = fusedInferenceTensorMs`.
   2. Mode from `BROADIFY_MEETING_OVERRUN_STEPDOWN` (read once, cached, like `overrunStepDownEnabled()`):
      `"0"` -> off (today: never set pending), `"always"` -> call the old unconditional overload,
      anything else / unset -> call the new sample overload.
   3. When the outcome is `NotTierBound`, emit one helper event (same `emitHelperEvent` mechanism):
      `{"type":"keyer_overrun_stepdown_skipped","tier":"<tier label>","program_frame_ema_ms":X,"budget_ms":X,
      "session_run_ms":X,"tensor_ms":X,"estimated_savings_ms":X,"projected_ms":X}`.
C. Fused env pin (`src/pipeline/frame_pipeline.cpp`)
   - When `BROADIFY_MEETING_KEYER_PERFORMANCE` is one of `high_quality|balanced|performance` (same validation as
     `fusedKeyerPerformanceOverrideActive()` / keyer_chain's `readKeyerPerformanceOverride`), the fused path must run
     at that mode: set `keyerSettings.performanceMode` to the pin value wherever the governor would otherwise set it,
     so the fused `apply()`, the warmup (`warmupMode`) and the telemetry (`fusedActiveMode`, `active_performance_mode`)
     all report the pinned mode. Add a cached accessor returning the validated pin string (empty when unset/invalid)
     and reuse it; do not duplicate parsing logic in more places than today.
D. Stage timings in the overrun event (Windows only, `src/pipeline/frame_pipeline.cpp`)
   - Measure, with `std::chrono::steady_clock`, the wall time of these blocks of the SAME program frame and add them
     as fields to the existing `keyer_budget_overrun` event (keep all existing fields and their order first):
     `keyer_section_ms` (the whole Windows keyer section of the frame: fused/async keying, stabilize, guided refine,
     postprocess), `guided_refine_ms` (sum of all guided refine calls in the frame, D3D11 or CPU),
     `postprocess_ms` (sum of postprocessAlpha calls), `render_ms` (renderProgramFrame call),
     `recorder_ms` (recorder.appendVideoFrame call), `preview_ms` (previewFrames.publish call),
     `vcam_ms` (the VCam shared-memory publish block before programEnd), and
     `other_ms = max(0, program_frame_ms - (keyer_section_ms + render_ms + recorder_ms + preview_ms + vcam_ms))`.
     guided_refine_ms and postprocess_ms are sub-parts of keyer_section_ms and must not be added again in other_ms.
   - Reset the per-frame accumulators at the start of every program frame. No timing work outside Windows builds
     (guard with `#if defined(_WIN32)` or keep the cost to a few steady_clock reads).
E. Docs: `docs/bridge/architecture/meeting-keyer-auto-degradation.md` and `docs/bridge/features/meeting-keyer-windows.md`:
   the measured-cost overrun rule, the `always` mode, the new skip event, the stage fields, the fixed fused pin.
F. Tests (`tests/keyer_governor_test.cpp`, ctest target `keyer_governor_test`, pure stdlib, runs on macOS):
   1. Sample overload, tier-bound: governor seeded via `seedMeasuredProbes(30, 11, 9)` (default config, no frame
      overhead -> seed threshold 0.8 * 33.33 = 26.67, so 30 does not fit and the seed lands on Balanced320) -> ratio 9/11
      (inside the clamp range [0.64, 1.0]). Sample (ema 40, budget 33.3, session 11, tensor 3) ->
      savings = 11*(1-9/11) + 3*(1-0.64) = 2.0 + 1.08 = 3.08 -> projected 36.92 > 33.3 -> NotTierBound;
      with ema 36 -> projected 32.92 <= 33.3 -> SteppedDown to Performance256. Assert decision, tier and the
      exact savings/projected values (tolerance 1e-9). Also a case with probes (320=11, 256=6): ratio 6/11=0.545
      is clamped up to 0.64 -> savings = 11*0.36 + 3*0.36 = 5.04.
   2. Probes equal (320=11, 256=11): savings only from tensor -> NotTierBound even at ema 35; state unchanged
      (tier, EMA, samples).
   3. Probes unknown (seedProbe path or zeros): ratio falls back to area -> decision matches the formula with area.
   4. Invalid sample (session 0 or ema 0 or budget 0) -> SteppedDown like the old overload.
   5. Inverted probes (256 slower than 320) -> ratio clamped to 1.0 -> savings from tensor only.
   6. From Full512 with probes (512=24, 320=11): ratio 11/24 within [0.390625, 1] -> verify savings.
   7. Old overload unchanged: existing tests still pass; add one test that it still steps down unconditionally.
   8. Step-up estimate: at Performance256 with probes (320=11, 256=11) and EMA 11 -> estimate 11 (ratio clamped
      to [1, 1.5625] -> 1.0); with probes unknown -> 11*1.5625; with probes (320=16, 256=8) -> clamped to 1.5625.
   9. `reset()` clears stored probes (after reset, estimates fall back to area).
   Do not weaken or delete existing assertions.

## Acceptance criteria
1. With default env, a program overrun steps the fused tier down only when the measured-cost projection of the
   lower tier fits the budget; otherwise the tier stays and a `keyer_overrun_stepdown_skipped` event is emitted.
2. `BROADIFY_MEETING_OVERRUN_STEPDOWN=always` reproduces today's unconditional behavior; `=0` keeps today's off behavior.
3. Without stored probes every estimate and decision equals the area-ratio math (backwards compatible).
4. Step-up estimates use the clamped measured probe ratio when probes exist.
5. The fused path honors `BROADIFY_MEETING_KEYER_PERFORMANCE` (apply, warmup, telemetry), governor does not override it.
6. `keyer_budget_overrun` carries the stage fields defined in D, measured on the same frame; existing fields unchanged.
7. All tests in F exist and pass; all existing ctest targets pass on macOS
   (`npm run build:meeting-helper && npm run test:meeting-helper-native`).
8. Changed files limited to: keyer_governor.h/.cpp, frame_pipeline.cpp, tests/keyer_governor_test.cpp, the two docs,
   TASK.md. No changes to matting_common, modnet_keyer, openvino_keyer, dml_device_input, webapp or macOS CoreML code.

## Constraints
- English code comments, existing naming/style, no reformatting of untouched code.
- Do not commit; leave changes in the working tree.
- If anything in the code contradicts this plan, stop and write the contradiction into the Review section
  instead of guessing.

## Review
- Round: 3/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
  - Implementer notes (2026-10-17), files and functions changed:
    - `src/keyer/keyer_governor.h`: new `ProgramOverrunSample`, `OverrunDecision`, `OverrunOutcome`;
      new overload `noteProgramBudgetOverrun(TimePoint, const ProgramOverrunSample &)`; private
      `sessionCostRatio()`, `storedProbeMs()`; members `probe512Ms_/probe320Ms_/probe256Ms_`; public
      introspection `stepUpEstimateMs()`; comments updated.
    - `src/keyer/keyer_governor.cpp`: file-local `isFusedTier()`; `estimatedStepUpMs()` now
      `emaMs_ * sessionCostRatio(tier_, target)` (same expression as before when probes are unknown);
      `seedMeasuredProbes()` stores probes; new overload; `reset()` clears probes. Old overload unchanged.
    - `src/pipeline/frame_pipeline.cpp` (Windows only): `overrunStepDownEnabled()` replaced by
      `OverrunStepDownMode overrunStepDownMode()`; `fusedKeyerPerformancePin()` added and
      `fusedKeyerPerformanceOverrideActive()` reimplemented on top of it; static
      `fusedProgramOverrunSample` stored with the pending flag; Measured/Always consumption plus
      `keyer_overrun_stepdown_skipped` event; pin applied after the governor block (see follow-up 1);
      stage accumulators and timers; 9 new fields appended to `keyer_budget_overrun` (incl.
      `graphics_ms`, follow-up 3); `fusedInferenceTier` tag (follow-up 2); fusedActiveMode comment updated.
    - `tests/keyer_governor_test.cpp`: F1-F9 blocks added after the existing ones; no existing assertion
      touched.
    - Docs: `docs/bridge/architecture/meeting-keyer-auto-degradation.md` (step-up estimate text, stored
      probes, new section "Program-Loop Overrun Step-Down", env matrix rows, `active_performance_mode`,
      unit-test list) and `docs/bridge/features/meeting-keyer-windows.md` (env rows, Field A/B rows,
      overrun/skip event field lists).
  - Deviations / interpretations (with reason):
    1. Test seam: public `stepUpEstimateMs()` was added (introspection section) because F8/F9 require
       exact estimate values and `estimatedStepUpMs()` is private. Plus private `storedProbeMs()` and
       file-local `isFusedTier()` as helpers of `sessionCostRatio()`.
    2. A1 guard read as "today's seeding guard without the 256 check": probes are stored when
       `!seeded_ && samples_ == 0`, before the `performance256Ms <= 0` return.
    3. `BROADIFY_MEETING_OVERRUN_STEPDOWN`: Off keeps today's `raw[0] == '0'` prefix test (the convention of
       every kill-switch in the file), so `=0` is byte-for-byte today's off behavior; `always` is an exact
       match; anything else / unset -> Measured. The bridge allowlist value pattern
       (`^[A-Za-z0-9._,+-]{1,64}$`, meeting-helper-manager.ts) already forwards `always`; no bridge change.
    4. SUPERSEDED by follow-up 1 (pin now also applies with `BROADIFY_MEETING_AUTO_DEGRADE=0`). Original
       note: C was first applied literally inside the `governorAutoEnabled` block. The handover warmup (`warmupMode`) and the load-retry warmup read `keyerSettings.performanceMode`,
       which now carries the pin, so neither line needed a change.
    5. D `keyer_section_ms` = two spans summed: (a) async submit + async pair selection, (b) from the
       same-frame async re-evaluation through the end of the fused block (live-snap, fused keying,
       stabilize, guided refine, postprocess, trailing fallback refine). The graphics FrameBus readers
       sit between the spans (now reported as `graphics_ms`, follow-up 3; not keyer work). `guided_refine_ms` covers all 6
       Windows guided-refine sites incl. the async live-snap and `refineLiveFusedFallbackMask` (lambda
       now also captures `&stageGuidedRefineMs`); `postprocess_ms` covers the 3 fused `postprocessAlpha`
       calls (the async worker's call runs on its own thread, not in the program frame).
    6. F2 "samples unchanged" is asserted behaviorally (no samples accessor): after the NotTierBound
       overrun, `maybeStepUp` at the original 10 s dwell still climbs, which needs the 10 pre-overrun
       samples and the original clock. Tier and EMA are asserted directly.
    7. Extra tests beyond F: Ignored cases + non-fused target (no 256 session -> Lite256) for the sample
       overload; `sessionCostRatio(Lite256, Performance256) == 1.0` via the estimate; field case under
       15 ms overhead (equal probes climb 256 -> 320, unknown probes stay at 256 = old behavior).
  - ~~Known residual~~ resolved in the follow-up below (stale-sample tag).
  - Follow-up (coordinator decisions on the open questions, 2026-10-17):
    1. Pin regardless of auto-degrade (supersedes deviation 4): the governor block now sets the governor
       mode only when `fusedKeyerPerformancePin()` is empty, and right AFTER the `governorAutoEnabled`
       block (before both warmup blocks) a valid pin overwrites `keyerSettings.performanceMode`, with
       or without auto-degradation. So `apply()`, the handover and load-retry warmups and
       `fusedActiveMode`/`active_performance_mode` all use the pin. Doc lines updated (env matrix
       `AUTO_DEGRADE=0` + `KEYER_PERFORMANCE` rows; Windows env table).
    2. Stale overrun sample: `ProgramOverrunSample` gained `GovernorTier tierAtEvent` (default `Off` =
       untagged, can never act). The new overload returns `Ignored` with no state change when
       `sample.tierAtEvent != tier()` (checked right after the not-seeded check); Ignored never emits
       the skip event. The order maybeStepUp -> consumption is unchanged. Pipeline: new per-frame local
       `fusedInferenceTier`, set together with `fusedInferenceSessionRunMs` in the inference branch
       (BEFORE `addSample()`) and in the overlap branch; copied into the sample at the event.
       Interpretation: the tag is the tier the event frame's costs were MEASURED at. It equals "the
       tier when the event fired" except when `addSample()` already stepped down within that same
       frame; tagging the end-of-frame tier would let exactly that stale sample (higher-tier costs)
       through to a second step-down, so the measured-at tier is the safer tag. `always` mode still
       calls the old sample-free overload unchanged (AC2: reproduces today's behavior exactly), so the
       stale guard applies to the default Measured mode only.
       Tests: the helper `overrunSample()` now takes the tier tag first (every call passes the tier the
       governor is at); new block "stale sample": tagged Full512 while at Balanced320 -> Ignored,
       savings/projected -1, tier/EMA unchanged and the original 10 s-dwell climb still fires
       (samples + clock preserved); the same numbers tagged Balanced320 step down (projected
       30 - 1.08 = 28.92); an untagged sample is Ignored. Mutation (stale check disabled) fails 6
       assertions.
    3. `graphics_ms`: the code between the two keyer spans is ONE contiguous block, timed with the
       existing boundary reads (end of keyer part 1 = graphics start, start of keyer part 2 = graphics
       end; no extra clock read). It covers `isGraphicsOutputActive`, `backGraphicsReader.latest()`,
       `frontGraphicsReader.latest()`, their new-frame timestamp checks and the work-trigger checks
       (`shouldRunProgramWork`/`shouldRunFusedKeyerWork`). Field emitted after `postprocess_ms`;
       `other_ms = max(0, program_frame_ms - (keyer_section + graphics + render + recorder + preview +
       vcam))`. Both docs describe it.
  - Arithmetic of every new expectation recomputed by hand (F1 3.08/36.92/32.92, clamp 5.04/34.96/32.96,
    F2 1.08/33.92, F3 5.04, F5 1.08, F6 14.828125/35.171875/30.171875, F8 11 / 17.1875 / 17.1875 / 15).
    Mutation check (scratch copies only): removing either clamp, reverting the estimate to the area
    expression, mutating NotTierBound into a step-down, or not clearing probes in `reset()` each make
    `keyer_governor_test` fail.
  - Round 2 (verifier MUST-FIX: 320 <-> 256 flapping at ~19-20 ms non-model overhead; `always` no full
    rollback), implemented as specified by the coordinator:
    1. Governor: `setProgramFrameState(programFrameEmaMs, budgetMs, tensorMs)` (stored as
       `programFrameEmaMs_/programBudgetMs_/programTensorMs_`, <= 0 = unknown, cleared by `reset()`).
       Pipeline (Windows fused path): called every frame right before `maybeStepUp()` with
       `fusedBudgetOverrunReporter.emaMs()`, `fusedReporterBudgetMs` and the new static
       `fusedLastInferenceTensorMs` (set at frame end on every frame that ran fused inference, next to
       the overhead EMA; reset to -1 on keyer disable together with the reporter).
    2. Step-up guard: private `stepUpBlockedByProgramFrame(target, estimate)`, evaluated in
       `maybeStepUp()` after the estimate check, only for fused -> fused climbs (incl. skips):
       `extra = max(0, estimate - EMA) + max(0, tensor) * (area(target)/area(tier) - 1)`; blocked when
       `programEma <= budget && programEma + extra > budget`; blocked = plain return (no state change).
       Unknown state / over budget -> climbs as before. Lite256 -> Performance256 and Off -> Lite256
       untouched (the guard requires a fused current tier).
    3. `KeyerGovernorConfig::measuredCostPolicy` (default true). false: `sessionCostRatio()` returns the
       area ratio everywhere (step-up estimates AND the sample overload's projection) and the guard is
       off. `makeFusedGovernorConfig()` sets it to `overrunStepDownMode() != Always`. Note: `=0` keeps the
       measured step-up estimate + guard (only the overrun step-down is off), as specified (only
       `always` is the rollback).
    4. Tests (block "Round 2"), expectations by hand: setup probes 24/13.7/12 seeded at 5 ms overhead
       (seed threshold 22.67 -> Balanced320), old overload -> Performance256, overhead 20 (step-down
       threshold 16.67, step-up threshold 13.33), EMA 11.5. Estimate 11.5 * 13.7/12 = 13.129167 (fits
       13.33); extra = 1.629167 + 3 * 0.5625 = 3.316667.
       (a) program EMA 31.5: 31.5 + 3.316667 = 34.816667 > 33.33 -> blocked; tier, EMA and holdoff (10 s)
       unchanged; (b) program EMA 40 (over budget) climbs - on the same instance at the same instant
       (proves samples + clock untouched by the block) and on a fresh one; boundary 29.9 + 3.316667 =
       33.216667 <= 33.33 climbs; (c) never set / EMA -1 / budget 0 / after `reset()` -> climbs;
       (d) policy off: area estimate 11.5 * 1.5625 = 17.96875 (> 13.33, no climb at overhead 20 = the
       origin/dev numbers); at overhead 0 (threshold 26.67) the area estimate fits and the guard is off
       -> climbs, while policy on with the same inputs is blocked; the sample projection falls back to
       area (savings 5.04 instead of 3.08). Mutations (scratch only) that disable the guard return,
       the over-budget exception, the tensor term, the policy check in `sessionCostRatio()` or the
       policy check in the guard each fail at least one assertion.
    5. Loop simulation: the verifier's `loop_sim.cpp` copied to
       `/private/tmp/claude-501/-Users-gabrielbaeuerle-broadify-bridge/a41b8a6f-25ac-4a0e-9d30-f3e4a4f0ec53/scratchpad/impl-b/loop_sim.cpp`,
       adapted to call `setProgramFrameState(reporter EMA, budget, last fused tensor)` before
       `maybeStepUp()` and to set `measuredCostPolicy = !always`; the `dev` column is the same sim
       compiled against `git show origin/dev:` governor + reporter (old overload, no new APIs).
       10 simulated minutes, verifier cost model a (sessions 512/320/256 = 24/12/11.5 ms, tensors
       4/3/1.92 ms, probes 24/13.7/12), transitions / final tier:

       | Overhead | measured | always | origin/dev |
       | --- | --- | --- | --- |
       | 17 ms | 0 / 320 | 0 / 320 | 0 / 320 |
       | 19 ms | 1 / 256 | 1 / 256 | 1 / 256 |
       | 20 ms | **60 / 320 (20 s periodic flap)** | 1 / 256 | 1 / 256 |
       | 21 ms | 0 / 320 (60 overruns skipped) | 1 / 256 | 1 / 256 |
       | 25 ms | 0 / 320 (60 overruns skipped) | 1 / 256 | 1 / 256 |

       Model b (256 session 10.5 ms): measured 0/1/1/0/0 transitions, finals 320/256/256/320/320; always
       and dev 0/1/1/1/1, finals 320/256/256/256/256. A 0.5 ms sweep 16-30 ms: `always` output is
       identical to origin/dev for every overhead in both models; measured mode flaps ONLY at 20.0 and
       20.5 ms in model a (60 transitions each), everywhere else <= 1 transition.
       Before Round 2 (verifier run): measured 108 transitions at 19 ms and 60 at 20 ms.
    - Results after Round 2: `npm run build:meeting-helper` OK (last line
      `Built .../Broadify Bridge Meeting Helper.app`, 0 compiler warnings); `npm run
      test:meeting-helper-native` final line: `100% tests passed, 0 tests failed out of 37`.
  - Round 3 (coordinator: option A + option B, both only with `measuredCostPolicy`; governor files and
    tests only, no pipeline change needed):
    A. Live-cost memory: members `liveCost512Ms_/liveCost320Ms_/liveCost256Ms_` (-1 = never measured),
       `storedLiveCostMs()`, `rememberLiveCostOfCurrentTier()` (stores the EMA of the tier being LEFT
       when `samples_ >= minSamples`, else keeps the previous value; policy off -> no-op). Called right
       before every tier change: `stepDown()`, the step-up in `maybeStepUp()`, Off -> Lite256 and
       `commitLiteStepUp()` (the last two leave non-fused tiers, so they are no-ops kept for
       uniformity); seeding does not call it. `sessionCostRatio()`: cost(from) = EMA if from is the
       current tier with >= minSamples, else stored live cost; cost(to) = stored live cost; live/live
       when both > 0, else probe/probe, else area; same clamps. `reset()` clears them. Staleness
       documented (refreshed only on a visit).
    B. Wrong-estimate net: config `overrunWrongEstimateWindow` (30 s); `lastFusedStepUpAt_` +
       `fusedStepUpAtValid_` set on every fused -> fused step-up (policy on). Every SteppedDown of the
       measured overload (projection and invalid-sample/non-fused fallback) goes through one local
       lambda: within the window it doubles `stepUpHoldoff_` (cap `reprobeMaxInterval`, never reset
       within the session). Interpretations, both to keep "exactly like the existing wrong-estimate
       doubling": (i) one doubling per wrong estimate - when stepDown()'s own 30-sample watch is still
       armed and doubles for the same step-down, the net does not double a second time; (ii) any
       step-down consumes the remembered climb (`stepDown()` clears it, like the watch), so the net
       fires at most once per climb. `reset()` clears it.
    Tests (block "Round 3", expectations by hand; shared path: overhead 5 -> thresholds 28.33/22.67,
    probes 24/13.7/12 -> Balanced320, 10 x 12 ms, old overload -> Performance256 storing live320 = 12,
    10 x 11.5 ms): (1) estimate 11.5 * 12/11.5 = 12.0 (probe: 13.129167); after the climb (live256 =
    11.5) and 30 x 12 ms at 320, ema 35 -> live savings 12 * (1 - 11.5/12) + 3 * 0.36 = 0.5 + 1.08 =
    1.58, projected 33.42 > 33.33 -> NotTierBound (probe would give 32.43 -> SteppedDown); (2) 9 samples
    -> nothing stored (estimate 13.129167); a 5-sample visit at 20 ms keeps live320 = 12 (estimate 12,
    not 17.96875); (3) reset -> probe estimate 13.129167 again and no net 2 s after a pre-reset climb
    (holdoff 10 s); (4) ema 34.5 -> projected 32.92 -> SteppedDown: at +20 s and exactly +30 s holdoff
    10 -> 20 s, at +31 s stays 10 s, with the watch still armed (10 samples) 20 s not 40 s;
    (5) policy off: estimate 17.96875, climbs, area savings 12 * 0.36 + 3 * 0.36 = 5.4 (projected 29.1)
    -> SteppedDown 20 s after the climb with holdoff still 10 s, estimate still 17.96875 afterwards.
    All existing assertions unchanged and passing (checked analytically and by run: earlier tests either
    never store live costs (< 10 samples when leaving) or the live ratio is clamped to the same value
    as the area ratio). Mutations (scratch): ignoring stored live costs, storing with < minSamples, not
    clearing live costs / step-up time in reset, disabling the net, double-doubling, and not storing on
    the climb each fail at least one assertion. Two mutations survive by construction: removing the
    policy check inside `rememberLiveCostOfCurrentTier()` or inside the net - with the policy off the
    live costs are never read (area ratio) and the climb time is never recorded, so both checks are
    redundant belts (kept for clarity).
    Simulation (the adapted loop_sim + the origin/dev build, 10 simulated minutes, overhead 16.0-30.0
    in 0.5 ms steps = 29 points per model, both modes; files in
    `/private/tmp/claude-501/-Users-gabrielbaeuerle-broadify-bridge/a41b8a6f-25ac-4a0e-9d30-f3e4a4f0ec53/scratchpad/impl-b/`
    `r3_*.txt`, `r3_table.txt`):
    - model a (256 session 11.5 ms): measured max 2 transitions; >1 only at 20.0 and 20.5 ms (2 each:
      320 -> 256 at 1.0 s, 256 -> 320 at 11.0 s, then 320 for 590 s with 58 overruns skipped) - no
      periodic pattern; 16-18 ms: 0 / 320, 18.5-19.5 ms: 1 / 256, 21-30 ms: 0 / 320.
    - model b (256 session 10.5 ms): measured max 1 transition (16-18 ms: 0 / 320, 18.5-20.5 ms:
      1 / 256, 21-30 ms: 0 / 320).
    - always: output byte-identical to origin/dev at all 29 points in both models (max 1 transition;
      16-18 ms 0 / 320, 18.5-30 ms 1 / 256).
    - Required result reached - for the FIXED-cost simulation only. Verifier note (round 3 passed, no
      must-fix): with frame-to-frame noise (±2 ms overhead, ±0.5 ms session) measured mode still makes
      5-16 tier transitions per 10 minutes in a band of about 18.5-21.5 ms non-model overhead (short 320
      visits about every 2 minutes once the step-up holdoff reaches its 120 s cap; at 20.5/21.5 ms some
      ~10 s dips to 256 every 2-3 minutes outside the 30 s net window), while origin/dev stays at 256
      there; above ~22 ms measured mode holds 320 with 0 transitions. Field testers: watch
      `meeting-helper-events.log` for repeating `keyer_policy_change` lines;
      `BROADIFY_MEETING_OVERRUN_STEPDOWN=always` restores the previous governor completely (restart
      Broadify Bridge; the `.env` is read at app start). Both docs state this.
    - Post-round-3 notes (no behavior change): class-level "Step-UP policy" comment in
      `keyer_governor.h` now names live costs, probes, area fallback, the program-frame guard and
      `measuredCostPolicy`. New test "R3-4b": climb 320 -> 512 at 10 s (estimate 5 * 2.56 = 12.8),
      30 x 10 ms clear the watch, two 100 ms samples (EMA 28, then 42.4 > 33.33) step down 512 -> 320
      without doubling, then a measured overrun at 20 s (probe savings 3.08, projected 32.92 ->
      SteppedDown) inside the 30 s window keeps the holdoff at 10 s because the sample-driven
      step-down consumed the climb. Mutation (no clearing in `stepDown()`) fails exactly this
      assertion.
    - Results after Round 3: `npm run build:meeting-helper` OK (last line
      `Built .../Broadify Bridge Meeting Helper.app`, 0 compiler warnings); `npm run
      test:meeting-helper-native` final line: `100% tests passed, 0 tests failed out of 37`
      (`keyer_governor_test ... Passed`).
  - NOT compiled or tested on macOS: the Windows fused-path changes in `frame_pipeline.cpp` (parts B, C, D,
    follow-ups 1-3 and Round 2 wiring; Round 3 did not touch the pipeline) sit in `#if defined(_WIN32)`
    code. Best-effort substitute (re-run after Round 3): a scratch copy of `src/` was `unifdef`-ed to the
    Windows branches (`-D_WIN32 -U__APPLE__`, 0 conditionals left, all new identifiers present) and
    `frame_pipeline.cpp` parsed with `clang++ -std=c++17 -fsyntax-only -Wall -Wextra -Wshadow`: 0 errors,
    0 warnings. That is not MSVC, not linked and not executed; the event output, the pin, the guard
    wiring and the skip path still need the Windows CI run and the field log.
- Handoff to human (if any):
  - (Resolved in Round 3 by options A + B; kept for the record.)
    Round 2 expectation "measured mode has no periodic flapping at any overhead" is NOT met in one band,
    with the rules exactly as specified. Model a, overhead ~19.9-20.9 ms: the 256 frame (O + 13.42 ms)
    is just over budget, so the guard's "over budget at both tiers -> climb" exception lets 256 climb;
    at 320 (O + 15 ms) the overrun rule projects 256 with the PROBE ratio 12/13.7 = 0.876 (savings
    12 * 0.124 + 3 * 0.36 = 2.57 ms -> projected O + 12.43 <= 33.33) and steps down, although the live
    256 frame is O + 13.42 > 33.33. Period = reporter repeat (10 s) + step-up holdoff (10 s); the
    30-sample wrong-estimate watch never fires because the overrun step-down comes ~10 s after the
    climb. Root cause: probe ratio (0.876) vs live ratio (11.5/12 = 0.958) - the two rules disagree
    about the 256 cost. Not fixed (would be new design, not in the spec). Options for the decision:
    - Option A (recommended, prototyped in scratch only:
      `/private/tmp/claude-501/-Users-gabrielbaeuerle-broadify-bridge/a41b8a6f-25ac-4a0e-9d30-f3e4a4f0ec53/scratchpad/impl-b/proto/`):
      remember the live session EMA of each fused tier when leaving it (>= minSamples) and let
      `sessionCostRatio()` prefer live/live over probe/probe (same clamps; probes, then area as
      fallbacks). Both rules then judge with real per-tier costs. Prototype result, 0.5 ms sweep
      16-30 ms, both cost models: max 2 transitions per 10 min (model a at 20/20.5 ms: 320 -> 256 ->
      320 once, then 58 overruns skipped, stays 320); no periodic flapping anywhere. Needs tests +
      decision on staleness (remembered EMAs are never refreshed while at the other tier).
    - Option B (smaller, bounded): count a measured overrun step-down within ~15 s of a step-up as a
      wrong estimate (holdoff doubling to the 120 s cap) - flapping decays to roughly one cycle per
      ~2 min instead of disappearing.
    - Option C: drop the over-budget exception (block whenever programEma + extra > budget) - no flap,
      but 256 never climbs back when the frame is over budget at both tiers, i.e. the original field
      complaint returns. Not recommended.

## Verification
- [ ] Tests pass (macOS ctest)
- [ ] Windows compile + native tests pass (test-release workflow on this branch)
- [ ] Field: events log on Gabriel's laptop shows skipped step-downs instead of 320 -> 256 drops

## Verifier (independent, not the implementer)
- Round 1: PASS; loop simulation found 320<->256 flapping at ~19-20 ms non-model overhead -> treated as must-fix.
- Round 2 (program-frame step-up guard, measuredCostPolicy / `always` = full rollback) and Round 3 (live-cost memory,
  wrong-estimate net): PASS, no must-fix. Verifier's own loop simulation, overhead 16-30 ms in 0.5 ms steps, two cost
  models: measured mode <= 2 transitions per 10 min (fixed costs), `always` byte-identical to origin/dev at all points.
  Field numbers (probes 24/13.7/12): 320 held at program EMA 37-45; 512 -> 320 still steps down at EMA 45.
- Residual (documented): with frame noise, 5-16 transitions per 10 min in a ~18.5-21.5 ms overhead band.
- Orchestrator re-run: build exit 0; ctest 37/37 after one unrelated failure of media_page_cache_test (timing-based,
  400 ms sleep; sources untouched by this branch; 150/150 repeats pass on this branch and on the fill-input branch).
- Open before merge: Windows CI compile + native tests (test-release workflow on this branch).
