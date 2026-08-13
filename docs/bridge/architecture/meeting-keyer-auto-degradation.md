# Meeting Keyer Auto-Degradation (Windows Fused Path)

## Summary

The Windows fused DirectML keyer self-tunes to the machine it runs on. Two
cooperating, stdlib-only components in the meeting helper decide how much
inference the program loop can afford:

- `src/keyer/keyer_governor.cpp` (`KeyerAutoGovernor`): picks the tier
  (inference resolution, async hand-off, or off).
- `src/pipeline/keyer_cadence.cpp` (`FusedCadenceController`): decides per
  frame whether to run inference or reuse the retained matte.
- `src/pipeline/mask_retention.cpp` (`MaskRetention`): async-path mask-age
  gate with adaptive retention instead of hard expiry (Windows only).

All are pure logic with injected time and are wired into the program loop in
`src/pipeline/frame_pipeline.cpp`. The governor mirrors the Apple/Vision
auto-quality governor in `keyer_chain.cpp` (EMA + hysteresis + doubling
backoff), generalized to a multi-tier ladder; step-UPS are estimate-based
(never live probes, see Thresholds).

## Tier Ladder

Best tier first. The governor only ever steps one tier at a time (except the
initial seed, which may jump).

| Tier | MODNet input | Execution |
| --- | --- | --- |
| `Full512` | 512 (`high_quality`) | fused synchronous, mask age 0 |
| `Balanced320` | 320 (`balanced`) | fused synchronous, mask age 0 |
| `Performance256` | 256 (`performance`) | fused synchronous, mask age 0 |
| `Lite256` | 256 | async worker (mask reuse keeps program at frame rate) |
| `Off` | – | passthrough, keyer status reports `gpu_too_slow` |

## Thresholds

- Frame budget: `1000 / fps` ms (33.3 ms at 30 fps).
- Step down: smoothed inference cost (EMA, newest-sample weight 0.2) exceeds
  `stepDownFactor (1.0) x frameBudgetMs`, after at least 10 samples.
- Fast start: an EMA above `2.5 x threshold` steps down after only 3 samples,
  so a hopeless tier does not stall the program loop for a full window.
- `Lite256 -> Off`: smoothed cost above 120 ms – even async masks would
  arrive too old to be useful. In `Lite256` the governor samples the ASYNC
  worker's measured inference cost (one sample per published mask pair), so
  this guard and the step-up estimate judge the live cost.
- Step up (estimate-based, NO live probes): the governor climbs one tier only
  when the higher tier's cost ESTIMATE fits the budget with strong margin:
  `estimatedMs(nextTierUp) <= stepUpFactor (0.7) x frameBudgetMs`. The
  estimate scales the current-tier EMA by the input pixel-area ratio
  (validated within ~10%): `320 -> 512` = x2.56, `256 -> 320` = x1.5625,
  `Lite256 -> Performance256` = x1.0 (same input size – the async-measured
  EMA carries over directly). Step-down stays at `1.0 x budget`, so the
  hysteresis band between climbing and falling is wide by construction.
  Additional requirements: at least 10 samples at the current tier AND at
  least the step-up holdoff (base 10 s) since the last tier change.
- Wrong estimate: if a step-up is followed by a step-down within 30 samples,
  the step-up holdoff doubles (capped at 600 s) persistently for the session
  – it never resets downward, so a borderline machine cannot re-enter a
  visible wobble at a fixed period.
- `Off -> Lite256`: stays time-based (async cannot stall the program loop and
  Off produces no samples to estimate from): backoff starts at 60 s, doubles
  (capped at 600 s) on every relapse to Off, never resets within a session.
- Reset: disabling the keyer resets governor (including the learned
  backoffs), cadence and mask retention (clean probe on re-enable). Camera
  hiccups do not reset learned state.

## Seed Heuristic

On session build the Windows warmup runs three timed inferences at the 512
shape; the median (run 1 carries the DirectML shape-compile stall) is exposed
as `status.probeInferenceMs` and seeds the governor once. MODNet inference
cost scales roughly linearly with input pixel AREA:

- 320 estimate = probe x (320/512)^2 = probe x 0.39
- 256 estimate = probe x (256/512)^2 = probe x 0.25

The governor jumps directly to the best tier whose estimate fits the step-down
threshold. Example, probe 194 ms at 30 fps (budget 33.3 ms): 512 = 194 ms,
320 ≈ 76 ms, 256 ≈ 48.5 ms – none fits the budget, but 48.5 ms ≤ 120 ms, so
the seed lands on `Lite256` instead of blocking the program loop for a full
observation window at 512.

## Inference Cadence (fused tiers)

Instead of blocking every program frame on a synchronous inference, the fused
path runs the model every Nth frame and reuses the retained raw matte in
between. The per-frame guided edge refine still runs against the CURRENT
camera frame, so the visible edge stays fresh.

- Auto N: `clamp(ceil(EMA / (frameBudgetMs x 0.8)), 1, 4)` – 20% headroom for
  compositing, at most every 4th frame.
- Forced inference triggers (any of): no reusable retained mask, retained mask
  older than 150 ms, motion score above 9.0, or N frames since the last
  completed inference. The motion score is the mean absolute luma difference
  (0..255) between 64x36 downsamples of the current and the last-inferred
  frame – the same scale as the pipeline's mask-motion constants (static < 6,
  clear motion > 30).
- Honest `mask_age`: reused frames report the real matte age in
  `keyer.get` metrics (`mask_age_ms`), set `degradation_stage` to
  `fused_reused`, and flag `stale_mask_active` once the age crosses the
  configured fresh threshold. A failed inference keeps forcing inference on
  the following frames until one lands.

## Async Mask Retention (Windows, `Lite256`/async path)

`src/pipeline/mask_retention.cpp` (`MaskRetention`) replaces the hard
mask-age expiry of the async path on Windows (macOS keeps the tuned
hard-expiry behavior unchanged). The old gate dropped any mask older than the
configured `maxMaskAgeMs` (150 ms), so a keyer that publishes masks slower
than that visibly turned keying OFF and ON around the gate.

- Adaptive gate: `effectiveMaxAgeMs = max(configured maxMaskAgeMs,
  2.5 x publish-interval EMA)`, capped at the hard cap – the gate follows the
  actual mask cadence, so a healthy-but-slow keyer never oscillates around it.
- Within the gate: the mask applies normally (`degradation_stage`
  `fresh`/`paired` as before).
- Between the gate and the hard cap (1500 ms): the last mask KEEPS being
  applied (the existing age-faded edge stabilization handles softening);
  `degradation_stage` reports the new value `stale_hold` and
  `stale_mask_active` is true.
- Beyond the hard cap: passthrough as before (frozen-mask protection), but
  only after 5 consecutive over-cap frames (hysteresis); a fresh mask leaves
  passthrough immediately. The worker-side mask-collapse guards are untouched
  and keep suppressing broken masks before they ever publish.

## Fused Postprocess Parity (2026-08-09)

Historical gap: the user-facing mask settings (`mask_erode_px`,
`mask_dilate_px`, `mask_feather_px`, `dynamic_dilation`,
`edge_stabilization_*`) were only ever applied inside the async worker's
`postprocessAlpha` chain. The fused path applied ONLY the collapse guard/EMA
(`stabilizeFusedMask`) plus the guided edge refine – the settings were
silently ignored, which is why fused@256 produced flickery, coarse edges the
async path never showed.

The Windows fused path now runs the identical `postprocessAlpha` chain
(morphological close -> smoothstep remap -> age-faded edge stabilization ->
erode -> dynamic dilate -> feather) AFTER the guided refine, on both real
inference frames (`maskAgeMs` 0) and cadence-reused frames (honest
`maskAgeMs`, so dynamic dilation and the edge-stabilization age fade behave
exactly like the async path). It runs at the guided-refine working
resolution (512x288, ~1-3 ms) and books its cost in
`metrics.mask_postprocess_ms`. Temporal continuity comes from the retained
last published (post-postprocess) fused mask; `blendAlphaTemporal` and the
worker's pre-refine bilateral are deliberately NOT applied (superseded by
the fused EMA and the guided refine respectively). The macOS fused block is
unchanged. Kill-switch: `BROADIFY_MEETING_FUSED_POSTPROCESS=0`.

## Path-Transition Reset Matrix (2026-08-09)

Telemetry/consumption ownership used to leak across path transitions: after
an `async_lite -> fused` step-up nothing cleared the worker's last pair, so
the async telemetry block kept reporting its unbounded age (38000+ ms
`mask_age_ms`, `keyer_fps` 0, stage `passthrough`) every frame while the
fused path was healthy – and `keyer_publish_to_program_ms` stayed
permanently stale in fused mode because only the async block ever wrote it
(and `updateMeetingKeyerStatus` preserves it across merges).

Fixes:

- The async consumption/telemetry blocks are gated on the async path being
  the ACTIVE source (the same predicate as the submit guard:
  `!gpuPipelineEnabled() || fused degraded`). While fused owns the keyer, the
  parked worker's pair is neither composited nor reported. Shared with macOS
  (the same race existed there); `BROADIFY_MEETING_GPU_PIPELINE=0` restores
  the pure async behavior.
- On ANY active-path change between `fused` (`fused_cadence` counts as
  fused), `async_lite` and `off`, a transition reset clears: async worker
  (incl. published pair and rate meters), mask-age average, mask retention,
  cadence, the retained fused mattes and the subject-presence tracker.
  Metrics fields the new path does not own are parked at -1 (counters at 0).
  Governor learning (tier, backoffs) survives – it caused the transition.
- The fused path owns `keyer_publish_to_program_ms` and writes -1 (no
  publish hop exists in fused mode).
- `keyer_pipeline_mode` never blanks while the section is active: the fused
  inference-failure branch reports `async_lite` (the fallback is the active
  source until a retry succeeds) and camera-hiccup frames keep the last
  reported mode sticky. Only a disabled keyer clears it to `null`.
- New additive status field `active_performance_mode` (`keyer.get`, next to
  the requested `performance_mode`): the mode actually driving the keyer –
  the governor's tier on the fused path, the async-lite floor
  (`performance`), or the webapp mode when auto-degradation is off. `null`
  on macOS / keyer disabled. The webapp metrics mapper reads only known
  keys, so the extra field is ignored safely until the UI adopts it.

## Warm Handover (make-before-break tier transitions, 2026-08-09)

Field symptom: "keyer visibly off for seconds a few minutes into the
session". Root cause: tier transitions cut over IMMEDIATELY, but the
DirectML session build for a new input shape is expensive — measured 0.25 s
on an idle discrete GPU and up to ~12 s on an iGPU under load:

- `async_lite -> fused` step-up: the transition reset parked the worker at
  once, while the first fused `apply()` still had to build/warm the session
  for the target size INSIDE the blocking program loop — seconds of un-keyed
  output.
- `fused -> async_lite` step-down: the worker's chain builds its session on
  the first submitted frame, so the program was un-keyed until the worker's
  first published pair.

Both directions are now make-before-break, coordinated by
`src/pipeline/tier_handover.cpp` (`TierHandover`, pure logic, injected time,
ctest-covered) wired into the Windows fused section of
`frame_pipeline.cpp`:

- Step-UP: with `KeyerGovernorConfig.deferLiteStepUp`, an estimate-approved
  `Lite256 -> Performance256` step-up does NOT change the tier; the governor
  latches `liteStepUpPending()`. The pipeline then runs a one-shot
  background thread (single-flight via an atomic busy flag; joined only
  after the thread body finished, so the program loop never blocks on a
  running build) that calls `MattingKeyer::warmupForPerformanceMode` — a new
  thread-safe entry that builds/shape-warms the session for the target mode
  under the keyer's internal mutex without producing a mask. The fused
  instance is verifiably idle in the Lite tier (its `apply()` only runs in
  the fused branch), so the warmup thread has it to itself. On success the
  pipeline commits the deferred step-up (`commitLiteStepUp` — exact
  immediate-step-up semantics incl. the wrong-estimate watch) and the fused
  branch takes over with a warm session; on failure `cancelLiteStepUp`
  applies the wrong-estimate treatment (persistent step-up holdoff doubling
  + dwell restart).
- Step-DOWN: on the first async-lite frame after a fused epoch,
  `g_fusedKeyerDegraded` goes true as before (the worker starts receiving
  frames), but the fused keyer KEEPS keying each frame (same chain: EMA
  stabilize -> guided refine -> postprocess parity; label stays `fused`;
  its inference cost is NOT sampled into the Lite EMA) until the worker's
  first pair published after the transition start arrives — then the
  standard path-transition reset runs, with the worker's fresh pair
  PRESERVED (clearing it would re-open the gap the overlap just bridged).
  Bounded: after 5 s without a published pair the cutover happens anyway
  with today's full reset. A fused inference failure during the overlap also
  cuts over immediately.
- Kill-switch: `BROADIFY_MEETING_WARM_HANDOVER=0` restores the immediate
  cutover in both directions (bridge forwards the env var).

## Empty-Subject Handling (`no_subject`, Option A, 2026-08-09)

When the person leaves the frame, the background now STAYS composited
instead of the keyer visibly "turning off". Previous mechanism: an all-zero
mask has no anchor pixel, so the shared plan builder fell back to the
un-keyed cover camera (`plan.camera.keyed=false`); on Windows the async
worker additionally held the last pair forever on collapse, ending in
`stale_hold`/`passthrough`. macOS only ever appeared to work because
residual matte noise kept the anchor alive – by accident, not by design.

- `SubjectPresenceTracker` (`src/pipeline/subject_presence.cpp`, pure logic,
  injected time): coverage >= 0.003 (`emptyAcceptCoverage`, deliberately
  below `kMinForegroundCoverage` 0.006) = present and resets the streak;
  below it, SUCCESSFUL inferences accumulate wall time; >= 400 ms
  (`acceptAfterMs`, cadence-independent) confirms the absence. Inference
  failures never advance the streak, so dropout protection is intact.
- Fused path (`stabilizeFusedMask`, shared macOS+Windows BY DESIGN): while
  the streak is unconfirmed the bounded collapse hold applies as before; on
  `ConfirmedEmpty` the empty matte passes through flagged
  `emptyValid`. Re-entry: the first confident frame resets to present.
- Async worker: on `ConfirmedEmpty` the (empty) pair is PUBLISHED with fresh
  stamps – retention stays in Apply (mask age ~0), no stale_hold/
  passthrough – instead of holding the last pair forever. Over-full and
  sudden-drop masks remain dropouts. Shared with macOS: there the worker
  only runs when CoreML failed, where background-only is equally desired.
- Compositor (shared plan builder + `MetalComposePlan.maskEmptyValid`): a
  flagged mask keeps `camera.keyed=true` in the anchor-less branch, the zero
  mask uploads and both shaders resolve it to alpha 0 -> background-only.
  Without the flag (model garbage) the un-keyed fallback stays. The CPU
  compositor already rendered background-only for anchor-less masks.
- Status: composing a confirmed-empty mask reports `degradation_stage`
  `no_subject` (never `passthrough`/`stale_hold`) on the async path and on
  the Windows fused path.
- Kill-switch: `BROADIFY_MEETING_EMPTY_SUBJECT=0` makes the trackers inert
  (never `ConfirmedEmpty`) – the previous behavior end-to-end.

## Ladder Verdict (2026-08-09)

On the measured field machines ({17, 40, 70} ms live 512-class inference),
fused@256 is the only clean fused rung: 320 with N=2 cadence was evaluated
and rejected – it produces bunched 8/65 ms frame pairs (visible judder
instead of a steady grid) and its live EMA sits above the step-down
threshold anyway, so the governor demotes it. The cadence stays as a safety
valve (motion-forced refresh, mask-age cap), not as a way to hold an
over-budget resolution.

## Status Field `keyer_pipeline_mode`

`keyer.get` reports the fused-path mode (bridge passes it through as
`keyer_pipeline_mode`, `null` when not reported – macOS or fused path
inactive):

| Value | Meaning |
| --- | --- |
| `fused` | fused synchronous inference, N = 1 |
| `fused_cadence` | fused with frame-skipping cadence, N > 1 |
| `async_lite` | governor handed the keyer to the async worker (`Lite256`), or the fused inference failed and the async fallback is active |
| `off` | governor stopped keying (`gpu_too_slow` passthrough) |

## Matting Backends (Windows)

The fused path (and KeyerChain's async keyer) obtain their MODNet keyer from
one factory, `src/keyer/matting_backend.cpp` (`createMattingKeyer`), so both
sites always run the same backend:

- `ModnetKeyer` (`src/keyer/modnet_keyer.cpp`): ONNX Runtime, DirectML EP on
  the best DXGI GPU, CPU fallback. The default everywhere.
- `OpenVinoKeyer` (`src/keyer/openvino_keyer.cpp`): OpenVINO runtime on Intel
  GPU/NPU. Windows-only and opt-in at build time
  (`MEETING_HELPER_ENABLE_OPENVINO=1` -> `BROADIFY_ENABLE_OPENVINO`); dist:win
  ships it. Both backends share the exact pre-/post-processing
  (`src/keyer/matting_common.cpp`), fill the same `KeyerStatus` contract
  (`backend` stays `modnet`; `provider` reports `openvino-npu` /
  `openvino-gpu` / `openvino-cpu` from the actually selected device) and feed
  the governor the same 3-run warmup-median `probeInferenceMs` at the 512
  shape.

Selection policy (evaluated once at keyer creation): OpenVINO is used when it
is compiled in AND not kill-switched AND (forced via env OR
`ov::Core::get_available_devices()` reports an `NPU*` device). An Intel GPU
alone deliberately does NOT trigger the auto-selection: measured on a UHD 630
(Gen9), FP32 OpenVINO-GPU is ~40% slower than DirectML on the same silicon,
and on hybrid laptops (Intel iGPU + discrete GPU) the trigger would steal the
keyer from a fast discrete DML adapter. Intel-GPU-only machines stay on
DirectML until the INT8 IR proves faster; use
`BROADIFY_MEETING_KEYER_BACKEND=openvino_modnet` for measurements.
Everything else - including macOS - gets `ModnetKeyer`. If the OpenVINO probe
throws, the keyer construction fails, or the backend later cannot load its
model (or fails inference repeatedly), one structured
`matting_backend_fallback` line is logged and the ONNX Runtime backend takes
over permanently for the process.

Like the DirectML path, OpenVINO compiles one static-shape model per input
size (512/320/256; NPU requires static shapes) and caches compiled models per
size; `ov::cache_dir` points at
`%LOCALAPPDATA%\Broadify\meeting-helper\openvino-cache` so GPU/NPU blob
compiles persist across helper restarts. An optional INT8 IR
(`models/modnet-ov-int8.xml/.bin`, produced offline via
`scripts/quantize-modnet-openvino.py`, manifest-verified) is preferred over
the FP32 ONNX when present.

Measured baseline (512 input, 2026-08-08, hybrid laptop GTX 1660 Ti + UHD 630):

| Hardware / path | 512 inference |
| --- | --- |
| GTX 1660 Ti via DirectML | 26.5 ms |
| Intel UHD 630 via DirectML | ~280-300 ms (256: ~80-113 ms -> governor lands at async-lite) |
| Intel UHD 630 via OpenVINO-GPU (FP32 ONNX) | ~416 ms (256: ~126 ms) - slower than DML on Gen9, hence the NPU-only auto policy |
| CPU (ORT) | ~195 ms |
| NPU / Arc-class iGPU via OpenVINO + INT8 IR (target) | 30-60 ms -> fused parity on office laptops; to be measured on Core-Ultra hardware |

Measurement gotcha: which adapter DirectML gets depends on how the process is
launched on hybrid-graphics laptops (Windows assigns the power-saving GPU to
directly launched unknown exes; the same binary spawned via node/the bridge
got the discrete GPU). Compare backends only within the same launch method.

Field findings 2026-08-09 (RC live test, GTX 1660 Ti + UHD 630, directml):
live inference can be 2-3x the isolated benchmark under GPU contention
(compositor/rendering/Teams competing for the GPU, possibly iGPU assignment
for the helper process) – 320 measured ~62 ms live vs 18-26 ms isolated. The
governor must therefore be judged against live EMAs, never against benchmark
numbers; this is why step-ups are estimate-based with a 0.7 margin instead of
live probes, and why `Lite256` feeds the async worker's measured cost back
into the governor.

## Environment Matrix

All variables are forwarded by the bridge (allowlist in
`meeting-helper-manager.ts`) and validated like the other
`BROADIFY_MEETING_*` overrides.

| Variable | Effect |
| --- | --- |
| `BROADIFY_MEETING_AUTO_DEGRADE=0` | Kill switch: resolution follows the webapp performance mode, no self-demote to async/off |
| `BROADIFY_MEETING_KEYER_CADENCE` | unset/`auto` = auto N; `0` = cadence inert (infer every frame); `N>=1` = pin N |
| `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` | Testing override for the governor's step-down threshold |
| `BROADIFY_MEETING_KEYER_PERFORMANCE` | Pins the input resolution (A/B testing); the governor keeps sampling but stops driving `performanceMode` |
| `BROADIFY_MEETING_GPU_PIPELINE=0` | Disables the fused path entirely (async worker path only) |
| `BROADIFY_MEETING_FUSED_POSTPROCESS=0` | Fused postprocess parity kill switch: the fused matte skips the erode/dilate/feather/edge-stabilization chain again |
| `BROADIFY_MEETING_EMPTY_SUBJECT=0` | Empty-subject (Option A) kill switch: an absent person is never confirmed; collapse-hold/anchor-fallback behavior as before |
| `BROADIFY_MEETING_KEYER_BACKEND` | `modnet` / `openvino_modnet` force the matting backend (read once by the factory) |
| `BROADIFY_MEETING_KEYER_OPENVINO=0` | OpenVINO kill switch: always the ONNX Runtime backend, even when forced |
| `BROADIFY_MEETING_OPENVINO_DEVICE` | `AUTO` (default; expands to OpenVINO `AUTO:NPU,GPU,CPU`) / `NPU` / `GPU` / `CPU` |

## Measurement Protocol

- `--keyer-self-test` (helper flag, used by
  `npm run test:meeting-helper-keyer[-hardware]`): 20 timed inferences per
  input size (512/320/256) on a deterministic synthetic frame; prints one
  JSON line per size with `backend`, `mean_ms`, `p95_ms`,
  `probe_inference_ms` and a final `keyer_self_test_summary`. With OpenVINO
  compiled in it benchmarks BOTH backends (sections `modnet` and
  `openvino_modnet`, distinguished additionally by the `provider` field) -
  the one-command DirectML-vs-OpenVINO A/B. Exit 0 only when every
  benchmarked backend loaded and produced masks.
  `BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER=cpu` skips the CoreML/DirectML
  providers and pins the OpenVINO device to CPU for hardware-independent CI
  timings.
- Live: `keyer.get` exposes `inference_ms`, the mask-stage metrics,
  `degradation_stage`, `stale_mask_active` and `keyer_pipeline_mode`.
- Unit tests: `keyer_governor_test` (incl. the 2026-08-09 field-regression
  scenario: async EMA 62 ms at a 33.3 ms budget must stay `async_lite` with
  zero transitions), `keyer_cadence_test`, `mask_retention_test` (adaptive
  gate, stale-hold window, hard-cap hysteresis), `subject_presence_test`
  (streak accumulation, dropout-vs-empty distinction, cadence-independent
  time-based acceptance, re-entry reset, inert kill-switch config) and
  `matting_backend_test` (backend selection policy + env parsing + factory
  fallback wiring) run via ctest (`npm run test:meeting-helper-native`).
