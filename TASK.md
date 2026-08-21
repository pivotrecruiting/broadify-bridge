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
- Focused native tests run during implementation:
  - `npm run test:meeting-helper-native -- --tests-regex matting_common_test` — passed.
  - `npm run test:meeting-helper-native -- --tests-regex 'keyer_governor_test|mask_retention_test|compositor_input_selection_test|matting_backend_test'` — passed.
  - `npm run test:meeting-helper-native -- --tests-regex 'guided_work_size_test|guided_mask_refine_test|subject_presence_test'` — passed.
- Focused Jest test during implementation:
  - `npx jest apps/bridge/src/services/meeting/meeting-helper-manager.test.ts --runInBand` — passed.

Deviations / macOS limits:
- Windows DirectML, D3D11 compositor, and OpenVINO runtime paths were not compiled or exercised on macOS; `_WIN32` gating was preserved and macOS helper build passed.
- D3D11 guided-filter coefficient EMA from C4 was not implemented in this bridge pass; radius/epsilon defaults and work-size parity were implemented and tested.
- Initial MODNet load is still triggered through the keyer load path; tier sessions are prebuilt at load and `apply()` no longer has a session rebuild path.
