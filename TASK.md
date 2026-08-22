# Task: WP2 — Windows keyer quality & dropouts (Stufe A)

## Context
- Bridge worktree: `win-stability-wp2` / `feature/win-stability-wp2`, base `feature/win-stability-wp1`.
- Webapp worktree (separate repo /Users/gabrielbaeuerle/broadify): `feature/meeting-keyer-platform-profile`, base `dev`.
- Evidence: analysis report sections 04/05. Paths relative to `apps/bridge/native/meeting-helper/src/`.

## Plan (one commit per block)

### Block A — Model input (`keyer/matting_common.cpp`, `keyer/modnet_keyer.cpp`)
A1. Letterbox (pad to square with the mean colour / 0 after normalisation) instead of squashing 16:9 into 1:1; keep
    a mapping struct so the output alpha is cropped back to the 16:9 region before upsampling.
A2. Area-average (box) downsample into the tensor (SIMD where WP1 helpers exist), replacing nearest sampling.
A3. Bilinear upsampling of the alpha to the working resolution (not nearest).
A4. ctest: letterbox mapping round-trip, box downsample vs reference, alpha crop correctness.

### Block B — No synchronous rebuilds, no raw-camera degradation (`keyer/modnet_keyer.cpp`, `keyer/keyer_governor.cpp`, `pipeline/frame_pipeline.cpp`, `pipeline/tier_handover.cpp`)
B1. Pre-build one ORT session per fused tier (512/320/256) at load time on the warm-handover thread; tier switches
    swap sessions (no rebuild in `apply()`). Memory budget env `BROADIFY_MEETING_KEYER_PREBUILD_TIERS` (default all).
B2. Initial load (hash + session + warmup) off the program thread; the program renders unkeyed-with-last-mask (or
    background-only if no mask yet) until ready — never blocks.
B3. Governor `Off` tier holds the last good mask (with the live-snap guided refine) instead of showing the raw camera;
    add a `keyer_degraded` status flag and status reason; reprobe schedule unchanged but capped at 120 s.
B4. Async-lite retention: `Passthrough` only when the worker is dead; otherwise keep `StaleHold` (last mask) until a
    new pair arrives.
B5. Governor seeds from a measured probe at the chosen tier instead of the 512 probe → no mandatory step-down after
    start; step-up threshold 0.8 × budget.

### Block C — Post-processing chain (`pipeline/frame_pipeline.cpp`, `compose/d3d11_compositor.cpp`, `pipeline/guided_mask_refine.cpp`)
C1. Work resolution for postprocess/feather ≥ 960×540 (env `BROADIFY_MEETING_MASK_WORK_WIDTH`, default 960).
C2. Remove the second alpha curve (18/242 + smoothstep) in the D3D11 compositor shader; keep one curve in postprocess.
C3. One temporal smoother on the fused path: keep motion-adaptive EMA, drop `stabilizeAlphaEdges` when EMA is active
    (or vice versa via env `BROADIFY_MEETING_FUSED_SMOOTHER=ema|edge`, default `ema`). On the async-lite path drop
    `blendAlphaTemporal` (0.85).
C4. Guided filter: add coefficient EMA (0.5, as on macOS) to the D3D11 implementation; align CPU fallback defaults
    with GPU (r=4, eps=1e-4 → both `5e-4` after A/B; make eps env-tunable as today).
C5. Subject presence: confirmed-empty requires ≥ 1500 ms AND coverage < 0.2 %; collapse guard upper bound 98 %.
C6. Structured log on EP selection (`keyer_provider`) and on every `fallback_reason`/`degradation_stage` change.

### Block D — Webapp platform profile (`/Users/gabrielbaeuerle/broadify/lib/meeting/meeting-keyer-profile.ts` + sync hook)
D1. `buildAutomaticMeetingKeyerPatch(platform)` — platform from the bridge status (`platform: "win32"|"darwin"`,
    add to the status snapshot if missing). Windows: edge_stabilization_strength 0.25, erode 0.25, feather 1;
    macOS: 0.5 / 0 / 1 (A/B-verified 21.08.).
D2. Only re-send the keyer patch when its content changed (already) AND not on every session hydration (guard against
    identical payloads after hydration).
D3. Unit tests for the profile per platform.

### Block E — Docs
E1. `docs/bridge/features/meeting-keyer-windows.md` (pipeline diagram, env/default matrix, tuning guide).

## Acceptance criteria
1. ctests for A4 pass; no nearest sampling remains in the tensor build.
2. No `rebuildSessionForSize` call reachable from `apply()` (review + unit test of the tier switch).
3. Governor Off never yields an unkeyed camera frame (unit test of the compositor input selection).
4. Shader has one alpha curve; postprocess works at ≥ 960 wide (unit test of the work-size selection).
5. Webapp profile tests per platform pass; bridge status exposes `platform`.
6. lint/jest/build/helper build/ctest green in both repos.

## Verification

- `npm run lint` — passed.
- `npm run test:jest` — passed: 173 suites, 1951 tests.
- `npm run build` — passed: includes Jest, release contracts, `build:protocol`, `build:bridge`, `build:graphics-renderer`, and app build.
- `npm run build:meeting-helper` — passed on macOS; helper and all native test binaries built.
- `npm run test:meeting-helper-native` — expected nonzero on this macOS sandbox: 21/22 CTests passed; only `meeting_recorder_writer_test` failed with known `audio_input_rejected` microphone sandbox issue.

Deviations / macOS limits:
- Windows DirectML, D3D11 compositor, and OpenVINO runtime paths were not compiled or exercised on macOS; `_WIN32` gating was preserved and macOS helper build passed.
- Manual Windows field checks still required: remove/rename the models dir and confirm `model_missing`, one retry launch per 30 s, and no warmup thread churn.
- `lastGoodMask` hold and `AsyncKeyerWorker::alive()` integration tests remain blocked by `frame_pipeline.cpp` structure; covered by review/manual checks.
## Review
- Round: 3/3
- Verdict: STOP — round 3 without PASS (bounded loop exhausted). HANDOFF to human.
- Resolved across rounds: A1–A4, B1 (prebuilt tiers), B3 (lastGoodMask Off hold), B4 (worker liveness), B5, C1–C3, C5, C6, C4 (coeff
  EMA), D-bridge (`platform`), E docs; macOS gating of all tuned constants; honest load-failure status + 30 s (effective 30–60 s)
  retry gate; async OpenVINO first load.
- Open after round 3 (both small, Windows-only):
  - HF-A COMPILE ERROR: `src/main.cpp:263-268` (OpenVINO self-test, `#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)`) passes
    `options.loadInApply` but `Options` has no such member → MSVC C2039. Fix: pass `true` (self-test wants a synchronous load).
  - HF-B REGRESSION: `matting_backend.cpp:55-57` with `loadInApply=false` a load-stage OpenVINO failure stays on OpenVINO forever
    (30 s retries) instead of handing over to DirectML. Fix: in `FallbackMattingKeyer::warmupForPerformanceMode`, when the primary
    warmup fails with a load-stage reason other than `loading`/`not_loaded`, log `matting_backend_fallback`, `primary_.reset()`, and
    return `fallback_->warmupForPerformanceMode(mode)` (safe: the program thread never touches the keyer while `fusedWarmupBusy`).
- Notes: retry cadence effectively 30–60 s (document or drop the keyer-internal backoff when `loadInApply=false`); add a ctest
  asserting that a failed load preserves `model_missing` under `loadInApply=false`.
- Handoff to human: decision needed — apply HF-A/HF-B as a handoff fix (one commit, re-verified) or leave WP2 out of the next RC.

## Verification

- `npm run lint` — passed.
- `npm run test:jest` — passed: 173 suites, 1951 tests.
- `npm run build` — passed: includes Jest, release contracts, `build:protocol`, `build:bridge`, `build:graphics-renderer`, and app build.
- `npm run build:meeting-helper` — passed on macOS; helper and all native test binaries built.
- `npm run test:meeting-helper-native` — expected nonzero on this macOS sandbox: 21/22 CTests passed; only `meeting_recorder_writer_test` failed with known `audio_input_rejected` microphone sandbox issue.

Deviations / macOS limits:
- Windows DirectML, D3D11 compositor, and OpenVINO runtime paths were not compiled or exercised on macOS; `_WIN32` gating was preserved and macOS helper build passed.
- Manual Windows field checks still required: remove/rename the models dir and confirm `model_missing`, one retry launch per 30 s, and no warmup thread churn.
- `lastGoodMask` hold and `AsyncKeyerWorker::alive()` integration tests remain blocked by `frame_pipeline.cpp` structure; covered by review/manual checks.
## Review
- Round: 2/3
- Verdict: MUST-FIX (round 2) — round-1 M2–M7 resolved, M1/M8 partially.
- Must-fix (open):
  - MF-1 `modnet_keyer.cpp` ~:240-244 + `frame_pipeline.cpp` ~:2424, 2488-2516: a failed first load must NOT be masked as
    `"loading"`. `apply()` sets `loading` only while a load has never been attempted or the warmup thread is in flight; otherwise it
    returns the stored failure status (`model_missing`, `session_create_failed`, `model_hash_mismatch`, …) untouched. The reload is
    triggered from the warmup block on any fallback once `kModelLoadRetryInterval` (30 s) elapsed, and the warmup thread is
    joined/re-armed independently of the governor/warm-handover blocks (must work with `BROADIFY_MEETING_AUTO_DEGRADE=0` and
    `BROADIFY_MEETING_WARM_HANDOVER=0`). No thread churn (max one warmup thread per 30 s while failing). Unit test with
    `BROADIFY_ENABLE_MODNET=0`-independent logic where possible (state machine factored out).
  - MF-2 `matting_backend.cpp` ~:162-186 / `openvino_keyer.cpp` ~:113-116: plumb `loadInApply` into `OpenVinoKeyer` (and the
    fallback wrapper) so the OpenVINO first load also runs on the warmup thread; same status/retry semantics as MF-1.
- Notes (do if cheap): reset the D3D11 guided coefficient history (`hasPrevAb`) in `resetKeyerPathState`; document the parallel
  first-load of the async KeyerChain instance; tests for `lastGoodMask` hold and `AsyncKeyerWorker::alive()` are BLOCKED by the
  frame_pipeline structure — record as manual checks (models dir removed → `model_missing`, one retry / 30 s, no thread churn).
- Handoff to human (if any): Windows compile only in CI; first-load/retry behaviour is a field check.

Round 2 implementation notes:
- MF-1 fixed: async MODNet `apply()` no longer overwrites post-attempt load failures with `loading`; the fused warmup thread is joined outside governor/warm-handover blocks and retries any fallback through a 30 s retry gate.
- MF-2 fixed: OpenVINO accepts `loadInApply`, warms through `warmupForPerformanceMode`, and the fallback wrapper preserves async load-stage failures for the same retry semantics.
- Cheap notes done: D3D11 guided coefficient history resets on keyer-path reset; the Windows keyer doc now calls out parallel first-load memory for the fused and async KeyerChain instances.
- Manual checks recorded: models dir removed -> `model_missing`, one retry / 30 s, no thread churn; `lastGoodMask` hold and `AsyncKeyerWorker::alive()` tests remain blocked by the frame-pipeline structure.

## Verification

- `npm run lint` — passed.
- `npm run test:jest` — passed: 173 suites, 1951 tests.
- `npm run build` — passed: includes Jest, release contracts, `build:protocol`, `build:bridge`, `build:graphics-renderer`, and app build.
- `npm run build:meeting-helper` — passed on macOS; helper and all native test binaries built.
- `npm run test:meeting-helper-native` — expected nonzero on this macOS sandbox: 21/22 CTests passed; only `meeting_recorder_writer_test` failed with known `audio_input_rejected` microphone sandbox issue.

Deviations / macOS limits:
- Windows DirectML, D3D11 compositor, and OpenVINO runtime paths were not compiled or exercised on macOS; `_WIN32` gating was preserved and macOS helper build passed.
- Manual Windows field checks still required: remove/rename the models dir and confirm `model_missing`, one retry launch per 30 s, and no warmup thread churn.
- `lastGoodMask` hold and `AsyncKeyerWorker::alive()` integration tests remain blocked by `frame_pipeline.cpp` structure; covered by review/manual checks.
## Review
- Round: 1/3
- Verdict: MUST-FIX (round 1)
- Must-fix (open):
  - M1 B2: initial MODNet load (hash + 3 tier sessions + warmups, up to several seconds) still runs synchronously in `apply()` →
    `ensureLoaded()` on the program thread. Run the initial load on the existing `fusedWarmupThread` (same `fusedWarmupBusy` guard);
    while `loaded_ == false`, `apply()` returns immediately with `fallbackReason="loading"` (no blocking) and the program branch serves
    the Off/hold compositor input until ready. ctest for the non-blocking behaviour (stub that sleeps in session creation).
  - M2 B3: the Off-tier "hold last mask" branch is dead: `resetKeyerPathState()` wipes `lastFusedRawMask` on every path change (incl.
    fused→async_lite and the first Off frame). Keep a separate `lastGoodMask` (updated from the fused publish AND the async worker's
    selected pair) that `resetKeyerPathState` does not clear, and source the Off hold from it. Unit test: fused→lite→off keeps a mask.
  - M3 B4: `workerAlive` is never passed to `MaskRetention::decide()` (defaults true) → a dead worker freezes the stale mask forever.
    Plumb real worker liveness (thread joinable + last-publish heartbeat) at both call sites; unit test.
  - M4 macOS unchanged: the CPU guided-refine defaults (8/1e-3 → 4/5e-4) and work grid (512 → 960) must apply on Windows only —
    gate with `#if defined(_WIN32)` (non-Windows keeps 512 / 8 / 1e-3).
  - M5 macOS unchanged: gate `kMaxForegroundCoverage` 0.98 and the subject-presence thresholds (0.2 % / 1500 ms) to Windows; keep
    0.92 / 0.003 / 400 ms on non-Windows. Fix `keyerDegraded` so it is true only for governor degradation / fallback while the keyer is
    enabled (not for `keyer_disabled`).
  - M6 C4: implement the guided-filter coefficient EMA (0.5) in the D3D11 implementation (as the macOS MPS path does); env
    `BROADIFY_MEETING_GUIDED_COEFF_EMA` (default 0.5, 0 = off). Windows-only.
  - M7 C3: replace the `maskAgeMs == 0.0` sentinel in `postprocessAlpha` with an explicit `fusedPath` parameter; make sure the Windows
    async-lite path always has exactly one temporal smoother, and cadence-reused fused frames do not stack `stabilizeAlphaEdges` on the
    EMA'd mask when the smoother is `ema`.
  - M8 tests/logging: add a unit test for the tier switch without rebuild (`PREBUILD_TIERS` incl. excluded-tier behaviour documented),
    and log `degradation_stage` changes (C6).
- Notes: document 3 sessions × 2 instances memory; box downsample could use SIMD (defer); BLOCKED for the reviewer: whether macOS
  production ever hits the ORT/letterbox path depends on the webapp's default keyer model (CoreML path untouched).
- Handoff to human (if any): Windows compile only in CI.

## Field regression (rc.21, 22.08.2026): mask frozen, refreshes every ~60 s — fix set
Diagnosis: governor lands in `Off` at start (`seedMeasuredProbes` seeds against 0.8×budget and may seed straight into Off when the
256 probe > 120 ms; probes are measured on the warmup thread while the async KeyerChain instance concurrently builds its own 3 DML
sessions on the same GPU; DML on the DIRECT queue competes with the compositor). Off = hold `lastGoodMask` + reprobe every 60→120 s
= exactly "frozen mask, ~10 fresh masks per minute, camera fluid". Fix:
- GR-1 `keyer_governor.cpp` `seedMeasuredProbes`: never seed below `Performance256` from build-time probes (clamp); Lite/Off only
  from live samples. Test.
- GR-2 `frame_pipeline.cpp`: during the fused first-load hold (`fusedWarmupInFlight`) do NOT feed the async worker (no
  `keyerWorker.submit`, no concurrent KeyerChain load); the worker starts only after the fused load finished or failed. Test of the
  gating predicate.
- GR-3 Off tier semantics: Off must never be a frozen hold. In Off, keep the async worker running at a reduced cadence (e.g. every
  4th frame, `Lite256` sessions) and composite its masks with live-snap; `lastGoodMask` hold only bridges gaps ≤ 2 s. Reprobe logic
  unchanged. Telemetry `keyer_pipeline_mode:"off_reduced"`.
- GR-4 `mask_retention.cpp`: StaleHold capped by age (hard cap 2 s) regardless of `workerAlive`; Passthrough after that (WP2's
  "worker alive" rule only extends the soft window).
- GR-5 DML queue type env-selectable `BROADIFY_MEETING_DML_QUEUE=compute|direct`, default `compute` (rc.18 behaviour; keying was
  fine there apart from the ring lag). Keep `direct` available for A/B.
- GR-6 Bridge `meeting-helper-manager.ts` forwarded env allow-list: add `BROADIFY_MEETING_GPU_POLICY`,
  `BROADIFY_MEETING_KEYER_PREBUILD_TIERS`, `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH`, `BROADIFY_MEETING_DML_QUEUE`,
  `BROADIFY_MEETING_STAGING_RING`, `BROADIFY_MEETING_GPU_RESIDENT` (jest test of the list).
- GR-7 Docs (`meeting-keyer-windows.md`, `meeting-windows-performance.md`): Off semantics, env A/B table, and the field
  discriminators (`keyer.get` fields: keyer_pipeline_mode, degradation_stage, fallback_reason, provider, gpu_adapter).
Acceptance: governor tests (no seed below 256 from probes; band); gating predicate test; retention cap test; env list test;
macOS unchanged; lint/jest/build/helper/ctests green.
