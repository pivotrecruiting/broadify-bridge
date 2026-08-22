# Windows Meeting Keyer

This document covers the Windows MODNet keyer path in the native meeting
helper. macOS uses the CoreML/Vision paths and does not use the shared MODNet
tensor helpers unless MODNet is explicitly selected.

## Pipeline

```text
camera frame
  -> MODNet input tensor
       - aspect-preserving square letterbox
       - mean-color padding, normalized to 0
       - area-average downsample
  -> MODNet inference
       - prebuilt 512 / 320 / 256 sessions when enabled
       - DirectML by default, OpenVINO when selected and compiled in
  -> alpha readback
       - crop out letterbox padding
       - emit the model-resolution content crop; compositor/guided refine
         resample it against the live camera
  -> fused or async-lite governor path
       - fused: current-frame inference when sustainable
       - async-lite: worker publishes mask/frame pairs
       - off_reduced: worker keeps running at reduced cadence, with live-snap;
         stale last-mask hold is capped at 2 s, then background-only
  -> guided edge refine
       - D3D11 when available, CPU fallback otherwise
       - work grid defaults to 512 px wide, aspect-preserving
  -> postprocess
       - close, smoothstep alpha curve, erode/dilate, feather
       - one temporal smoother on fused path
  -> compositor
       - D3D11 samples the postprocessed alpha directly
```

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `BROADIFY_MEETING_GPU_PIPELINE` | `1` | Enables the fused Windows GPU keyer path. Set `0` for async worker path. |
| `BROADIFY_MEETING_AUTO_DEGRADE` | `1` | Enables the fused tier governor. |
| `BROADIFY_MEETING_WARM_HANDOVER` | `1` | Keeps make-before-break transitions between fused and async-lite. |
| `BROADIFY_MEETING_KEYER_PREBUILD_TIERS` | `all` | Prebuilds MODNet sessions. Accepts `all`, `512`, `320`, `256`, or mode names in a comma list. |
| `BROADIFY_MEETING_DML_QUEUE` | `compute` | DirectML DML1 command queue type. Use `direct` for A/B against rc.21. |
| `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` | unset | Overrides the governor step-down threshold for tests/tuning. |
| `BROADIFY_MEETING_KEYER_CADENCE` | `auto` | Auto cadence, `0` disabled, or integer frame interval. Auto defaults to maxN 2 and motion threshold 4. |
| `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH` | `1` | Enables cadence reuse of retained fused masks. |
| `BROADIFY_MEETING_FUSED_POSTPROCESS` | `1` | Applies the postprocess chain on fused masks. |
| `BROADIFY_MEETING_FUSED_SMOOTHER` | `ema` | `ema` uses motion-adaptive EMA and disables edge stabilization for fused masks; `edge` uses edge stabilization instead. |
| `BROADIFY_MEETING_FUSED_EMA_STATIC` | `0.85` | Static-subject EMA weight for fused-mask stabilization. |
| `BROADIFY_MEETING_MASK_WORK_WIDTH` | `512` | Guided-refine/postprocess work width cap. 16:9 defaults to 512x288. |
| `BROADIFY_MEETING_GUIDED_RADIUS` | `4` | Guided-filter radius for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_EPSILON` | `5e-4` | Guided-filter epsilon for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_COEFF_EMA` | `0` | D3D11 guided-filter coefficient EMA; default off to avoid silhouette trails. |
| `BROADIFY_MEETING_GPU_GUIDED` | `1` | Enables D3D11 guided refine; set `0` for CPU fallback. |
| `BROADIFY_MEETING_CAMERA_MAX_HEIGHT` | `720` | Clamps Windows MediaFoundation camera requests and reopen attempts to <=720p at <=30 fps. |
| `BROADIFY_MEETING_EMPTY_SUBJECT` | `1` | Allows confirmed-empty subject masks after 400 ms below the foreground floor. |
| `BROADIFY_MEETING_KEYER_DML_LEGACY` | unset | Forces legacy DirectML device 0 selection. |

## Field A/B

| Scenario | Env | Expected discriminator |
| --- | --- | --- |
| rc.18-style DML queue | `BROADIFY_MEETING_DML_QUEUE=compute` | Lower compositor contention; default. |
| rc.21 queue comparison | `BROADIFY_MEETING_DML_QUEUE=direct` | Direct queue can compete with D3D11 compositor on weak GPUs. |
| Governor disabled | `BROADIFY_MEETING_AUTO_DEGRADE=0` | `keyer_pipeline_mode` stays fused/fused_cadence unless the keyer fails. |
| No fused cadence reuse | `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` | `metrics.mask_age_ms` stays near 0 on fused frames. |
| Prebuild only 256 | `BROADIFY_MEETING_KEYER_PREBUILD_TIERS=256` | First-load memory lower; step-up to missing tiers cannot warm. |

## Tuning

- Start with defaults. They are chosen to avoid raw-camera dropouts and avoid
  DirectML shape rebuilds during visible frames.
- Use `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` only for reproducing governor
  transitions. Production should normally use the frame-budget derived value.
- If edges look too soft, lower `BROADIFY_MEETING_GUIDED_EPSILON` slightly or
  increase `BROADIFY_MEETING_GUIDED_RADIUS`. If edges chatter, raise epsilon.
- If fused output trails on motion, keep `BROADIFY_MEETING_FUSED_SMOOTHER=ema`
  and tune `BROADIFY_MEETING_FUSED_EMA_STATIC` /
  `BROADIFY_MEETING_FUSED_EMA_MOTION` before switching to `edge`.
- If memory pressure matters more than transition smoothness, restrict
  `BROADIFY_MEETING_KEYER_PREBUILD_TIERS` to the expected modes. Excluding a
  tier means the helper will not synchronously build it from `apply()`; it will
  keep the current prebuilt session. The default `all` builds three tier
  sessions per keyer instance; with async and fused keyers active, that is two
  instances.
- With async first-load (`loadInApply=false` internally), failed model loads are
  retried by the warmup path at most once per 30 s. Because retry scheduling is
  checked from the program loop and waits for any previous warmup thread to be
  joined first, the effective visible cadence is usually 30-60 s.
- OpenVINO session builds use `intraOpThreads = 1` so background warmup and
  fallback retries do not fan out across CPU cores while the compositor is
  trying to maintain frame pacing.

## Status And Logs

Bridge status exposes:

- `platform`: Node `process.platform`, surfaced in `meeting_get_state`.
- `keyer_degraded`: true when the helper is serving a degraded keyer state.
- `fallback_reason`: reason for the current fallback/degradation.
- `provider`: active inference provider, for example `directml`.
- `gpu_adapter`: selected DirectML/D3D adapter identity.
- `keyer_pipeline_mode`: `fused`, `fused_cadence`, `async_lite`, or
  `off_reduced`.
- `degradation_stage`: `fresh`, `paired`, `stale_hold`, `off_reduced`,
  `background_only`, or the active fused stage.
- `active_performance_mode`: effective keyer performance tier.

Native logs include `keyer_provider` changes and fallback-reason changes so
provider selection and degradation transitions are visible in helper logs.
