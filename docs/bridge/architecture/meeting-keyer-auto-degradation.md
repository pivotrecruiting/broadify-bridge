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

## Status Field `keyer_pipeline_mode`

`keyer.get` reports the fused-path mode (bridge passes it through as
`keyer_pipeline_mode`, `null` when not reported – macOS or fused path
inactive):

| Value | Meaning |
| --- | --- |
| `fused` | fused synchronous inference, N = 1 |
| `fused_cadence` | fused with frame-skipping cadence, N > 1 |
| `async_lite` | governor handed the keyer to the async worker (`Lite256`) |
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
  gate, stale-hold window, hard-cap hysteresis) and `matting_backend_test`
  (backend selection policy + env parsing + factory fallback wiring) run via
  ctest (`npm run test:meeting-helper-native`).
