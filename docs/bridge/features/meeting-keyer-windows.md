# Windows Meeting Keyer

This document covers the Windows MODNet keyer path in the native meeting
helper. macOS uses the CoreML/Vision paths and does not use the shared MODNet
tensor helpers unless MODNet is explicitly selected.

## Pipeline

```text
camera frame
  -> MODNet input tensor (N x N, N = 512 / 320 / 256)
       - default (fill): whole frame stretched over the full square, no bars
         (same geometry as the macOS CoreML path and the training data)
       - kill switch BROADIFY_MEETING_KEYER_LETTERBOX=1: aspect-preserving
         square letterbox with mean-color padding, normalized to 0
       - area-average downsample
  -> MODNet inference
       - prebuilt 512 / 320 / 256 sessions when enabled
       - DirectML by default, OpenVINO when selected and compiled in
  -> alpha readback
       - fill: bilinear resample of the full model alpha to the letterbox
         content size (e.g. 512x288 / 320x180 / 256x144 for 16:9)
       - letterbox: crop out the padding
       - either way the emitted mask has the same size; compositor/guided
         refine resample it against the live camera
  -> fused or async-lite governor path
       - fused: current-frame inference when sustainable
       - async-lite: worker publishes mask/frame pairs
       - with a VCam client connected, fused cadence is pinned to every frame;
         the governor steps 512 -> 320 -> 256 before async-lite, and
         async-lite requires 30 consecutive over-budget samples at fused 256
       - async-lite/off_reduced composite the worker's paired frame while VCam
         is connected, avoiding a live frame with an aged mask
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
| `BROADIFY_MEETING_OVERRUN_STEPDOWN` | unset (measured) | Sustained program-loop budget overrun handling. Default: step one fused tier down only when the measured-cost projection of the lower tier (`program_frame_ema_ms - savings` from the smaller session and tensor) fits the budget; otherwise keep the tier and log `keyer_overrun_stepdown_skipped`. Cost ratios between fused tiers use the live session costs remembered per tier (refreshed only when the governor visits a tier), else the build-time probes; fused step-ups are not taken when they would push an in-budget program frame over budget; a measured step-down within 30 s of a fused climb doubles the step-up holdoff. `always` is the full rollback to the pre-2026-10-17 governor (unconditional one-tier step-down, area cost ratios, no live-cost memory, no step-up guard, no wrong-estimate net); `0` keeps overruns log-only. |
| `BROADIFY_MEETING_KEYER_PERFORMANCE` | unset | Pins the MODNet input resolution (`high_quality` / `balanced` / `performance`) for A/B tests. The fused path now runs and reports the pinned mode (`apply()`, warmups, `active_performance_mode`); the governor keeps sampling but no longer drives the mode. The pin also wins over the webapp mode with `BROADIFY_MEETING_AUTO_DEGRADE=0`. |
| `BROADIFY_MEETING_WARM_HANDOVER` | `1` | Keeps make-before-break transitions between fused and async-lite. |
| `BROADIFY_MEETING_KEYER_PREBUILD_TIERS` | `512,320,256` | Prebuilds all three fused tiers on first load so the governor has a fine 320 middle step (avoids the coarse-256 edge flicker). Accepts `all`, `active`, `512`, `320`, `256`, or mode names in a comma list. |
| `BROADIFY_MEETING_DML_QUEUE` | `compute` | DirectML DML1 command queue type. Use `direct` for A/B against rc.21. |
| `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` | unset | Overrides the governor step-down threshold for tests/tuning. |
| `BROADIFY_MEETING_KEYER_CADENCE` | `auto` | Auto cadence, `0` disabled, or integer frame interval. Auto defaults to maxN 2 and motion threshold 4. |
| `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH` | `1` | Enables cadence reuse of retained fused masks. |
| `BROADIFY_MEETING_FUSED_POSTPROCESS` | `1` | Applies the postprocess chain on fused masks. |
| `BROADIFY_MEETING_FUSED_SMOOTHER` | `ema` | `ema` uses motion-adaptive EMA and disables edge stabilization for fused masks; `edge` uses edge stabilization instead. |
| `BROADIFY_MEETING_FUSED_EMA_STATIC` | `0.92` | Static-subject EMA weight for fused-mask stabilization. |
| `BROADIFY_MEETING_MASK_WORK_WIDTH` | `512` | Guided-refine/postprocess work width pin. When unset, the governor caps the effective work width by tier: Full512 unrestricted, Balanced320 640, Performance256/Lite256/Off 512. 16:9 defaults to 512x288 in this PR. |
| `BROADIFY_MEETING_GUIDED_RADIUS` | `4` | Guided-filter radius for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_EPSILON` | `5e-4` | Guided-filter epsilon for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_COEFF_EMA` | `0` | D3D11 guided-filter coefficient EMA; default off to avoid silhouette trails. |
| `BROADIFY_MEETING_GPU_GUIDED` | `1` | Enables D3D11 guided refine; set `0` for CPU fallback. |
| `BROADIFY_MEETING_STAGING_RING` | `1` | Pipelines the compositor readback through a depth-3 staging ring (maps frame N-1, ~1 frame added latency). Set `0` to restore the rc.18 blocking current-frame readback. |
| `BROADIFY_MEETING_CAMERA_MAX_HEIGHT` | `1080` | Clamps Windows MediaFoundation camera requests and reopen attempts to <=1080p at <=30 fps. `0` disables the height clamp. |
| `BROADIFY_MEETING_EMPTY_SUBJECT` | `1` | Allows confirmed-empty subject masks after 400 ms below the foreground floor. |
| `BROADIFY_MEETING_KEYER_DML_LEGACY` | unset | Forces legacy DirectML device 0 selection. |
| `BROADIFY_MEETING_KEYER_LETTERBOX` | unset | `1` restores the letterbox input geometry used up to 0.27.3-rc.6 (grey bars, byte-identical tensor and mask). Any other value or unset keeps the default fill geometry. Read once per helper process. |

## Input Geometry

Windows feeds MODNet the whole camera frame stretched over the N x N tensor
(`ModnetInputGeometry::Fill` in `keyer/matting_common.cpp`), like the macOS
CoreML path (`coreml_keyer.mm`) and the training geometry
(`broadify-keyer-training/scripts/fabrik.py`). Before, the frame was
letterboxed with mid-grey bars: at N = 256 a 1920x1080 frame kept only
256x144 content pixels, and the governor commonly runs 256 (`performance`) or
320 (`balanced`) on weaker laptops.

- Tensor shapes, tier sizes, prebuilt sessions and probes are unchanged
  (DirectML compiles kernels for the first Run shape; a different shape would
  recompile every Run).
- The emitted `AlphaMask` keeps the letterbox content size (512x288,
  320x180, 256x144 for 1920x1080), so everything downstream sees the same
  dimensions as before.
- CPU, fp16, zero-copy (including its CPU parity reference) and OpenVINO use
  the same geometry per process. The zero-copy shader needs no change: a fill
  mapping is a content rect covering the whole tensor.
- The helper reports the active geometry once per process when the keyer
  session loads, on stdout as
  `{"type":"meeting_keyer","event":"input_geometry","geometry":"fill"}`
  (or `"letterbox"`) and in the helper events log
  (`%APPDATA%\Broadify Bridge RC\meeting-helper-events.log`, rewritten on
  every helper start) as
  `{"type":"keyer_input_geometry","geometry":"fill","backend":"modnet"}`
  (`backend` is `openvino` for the OpenVINO keyer).
- Kill switch: `BROADIFY_MEETING_KEYER_LETTERBOX=1`. The helper inherits the
  bridge environment, so a line `BROADIFY_MEETING_KEYER_LETTERBOX=1` in
  `%APPDATA%\Broadify Bridge RC\.env` restores the letterbox after restarting
  Broadify Bridge (the `.env` is read at app start).
- Non-Windows builds always use the letterbox helpers unchanged.
- Frames smaller than N in a dimension (for example 640x480 or 640x360 at
  N = 512): in fill, an empty source block is widened to its nearest source
  row/column with the zero-copy shader's bounds rule, so every tensor element
  averages at least one real pixel and no grey rows appear; CPU and shader use
  identical block bounds. The letterbox kill switch keeps the old behavior
  (empty blocks of tiny sources such as 320x240 at N = 512 stay mid-grey on
  the CPU, so the opt-in zero-copy parity gate turns zero-copy off there).
- Known limitation: sources with fewer rows than the tier (for example
  768x432, 640x480 or 848x480 at tier 512) are upscaled by nearest-row
  duplication (the GPU shader's bounds rule, kept for CPU/GPU parity) and are
  marginally worse at 512 than letterbox (about +0.2 points on the lab set,
  see the real-code table below). 1080p and 720p cameras are unaffected.

Share of the true person cut away ("eaten", model ft-v7d, clean / webcam).

Python emulation of both geometries (lab set, 60 frames each, ONNX export on
CPU; source `broadify-keyer-training/models/results/win-fressen-20261017/`
`BEFUND.md` plus the raw `lab*.json`, script
`broadify-keyer-training/scripts/win_fressen.py`):

| Tensor | Letterbox (before) | Fill (now) |
| --- | --- | --- |
| 256 | 8.84 % / 11.17 % | 3.87 % / 4.89 % |
| 320 | 3.37 % / 5.94 % | 2.64 % / 3.48 % |
| 512 | 1.24 % / 2.64 % | 1.19 % / 2.44 % |

Real code (independent verification run: C++ `matting_common.cpp` + ft-v7d
ONNX, lab frames 768x432, 60 + 60 frames):

| Tensor | 768x432 Letterbox | 768x432 Fill | upscaled to 1080p Letterbox | upscaled to 1080p Fill |
| --- | --- | --- | --- | --- |
| 512 | 1.41 % / 2.76 % | 1.63 % / 2.91 % | 1.28 % / 2.72 % | 1.24 % / 2.48 % |
| 320 | 3.70 % / 5.89 % | 2.76 % / 3.79 % | 3.33 % / 5.97 % | 2.62 % / 3.49 % |
| 256 | 8.84 % / 11.17 % | 3.83 % / 5.31 % | 8.63 % / 11.26 % | 3.84 % / 5.01 % |

## Field A/B

| Scenario | Env | Expected discriminator |
| --- | --- | --- |
| rc.18-style DML queue | `BROADIFY_MEETING_DML_QUEUE=compute` | Lower compositor contention; default. |
| rc.21 queue comparison | `BROADIFY_MEETING_DML_QUEUE=direct` | Direct queue can compete with D3D11 compositor on weak GPUs. |
| Governor disabled | `BROADIFY_MEETING_AUTO_DEGRADE=0` | `keyer_pipeline_mode` stays fused/fused_cadence unless the keyer fails. |
| No fused cadence reuse | `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` | `metrics.mask_age_ms` stays near 0 on fused frames. |
| Prebuild only 256 | `BROADIFY_MEETING_KEYER_PREBUILD_TIERS=256` | First-load memory lower; step-up to missing tiers cannot warm. |
| Pre-2026-10-17 governor (full rollback) | `BROADIFY_MEETING_OVERRUN_STEPDOWN=always` | Every confirmed `keyer_budget_overrun` drops one fused tier again; no `keyer_overrun_stepdown_skipped` lines; step-up estimates use the area ratio again (no program-frame guard). |
| Fixed fused resolution | `BROADIFY_MEETING_KEYER_PERFORMANCE=balanced` | `active_performance_mode` stays `balanced` on the fused path regardless of the governor tier. |
| Letterbox input (pre-fill) | `BROADIFY_MEETING_KEYER_LETTERBOX=1` in `%APPDATA%\Broadify Bridge RC\.env`, then restart Broadify Bridge | Look for `keyer_input_geometry` in `%APPDATA%\Broadify Bridge RC\meeting-helper-events.log`: `"geometry":"letterbox"` (default: `"fill"`); more of the person is cut away at 320/256. |

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
  keep the current prebuilt session. The default `active,256` builds only the
  current high tier and 256 on first load; `all` builds three tier sessions per
  keyer instance.
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
- `keyer_ready`: false while the enabled keyer is still loading/not loaded.
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
The `meeting_keyer` `input_geometry` event reports `fill` or `letterbox` once
per helper process.

Program-loop budget events (`meeting-helper-events.log`):

- `keyer_budget_overrun`: sustained program-frame overrun (reporter EMA over
  budget for 30 frames, at most every 10 s). Fields, in order:
  `program_frame_ms`, `session_run_ms`, `tensor_ms`, `camera_copy_ms`,
  `camera_upload_ms`, `tier`, `cadence_n`, then the stage timings of the SAME
  frame: `keyer_section_ms` (async submit/selection, live-snap and the whole
  fused section), `guided_refine_ms` and `postprocess_ms` (both already
  included in `keyer_section_ms`), `graphics_ms` (graphics-output gate, back
  and front graphics FrameBus reads with their new-frame checks, and the
  work-trigger checks between the two keyer spans), `render_ms`,
  `recorder_ms`, `preview_ms`, `vcam_ms` and `other_ms` =
  `max(0, program_frame_ms - (keyer_section + graphics + render + recorder +
  preview + vcam))`.
- `keyer_overrun_stepdown_skipped`: the measured-cost projection says the
  next lower fused tier would not bring the frame into budget, so the tier
  stays. Fields: `tier`, `program_frame_ema_ms`, `budget_ms`,
  `session_run_ms`, `tensor_ms`, `estimated_savings_ms`, `projected_ms`.
  A sample whose tier changed before it was consumed is discarded silently
  (no step-down, no event). Details:
  `docs/bridge/architecture/meeting-keyer-auto-degradation.md`
  (Program-Loop Overrun Step-Down).
- `keyer_budget_recovered`: the reporter EMA is back within budget.

Known residual of the measured governor (loop simulation, 2026-10-17): with
fixed per-frame costs it makes at most 2 tier transitions per 10 minutes and
shows no periodic pattern. With frame-to-frame noise (±2 ms overhead, ±0.5 ms
session) it still makes 5–16 tier transitions per 10 minutes in a band of
about 18.5–21.5 ms non-model overhead (short 320 visits about every 2 minutes
once the step-up holdoff reaches its 120 s cap; at 20.5/21.5 ms some ~10 s
dips to 256 every 2–3 minutes outside the 30 s wrong-estimate window), where
the previous governor stays at 256. Above ~22 ms it holds 320 with 0
transitions.

Field testers: look for repeating `keyer_policy_change` lines in
`meeting-helper-events.log` (the tier going back and forth every few
minutes). `BROADIFY_MEETING_OVERRUN_STEPDOWN=always` restores the previous
governor completely; restart Broadify Bridge after setting it (the `.env` is
read at app start).

## Teams Grey Triage

Check in this order:

1. `keyer.get.status.keyer_ready`: false means the helper is intentionally
   rendering background-only while the keyer loads; the helper also emits
   `keyer_not_ready` with the reason.
2. Raw stream: look for `output.vcam.raw.start`, `meeting_vcam_raw`
   `client_connected`, and `no_frame_on_connect` if Teams connected before any
   program frame existed.
3. DLL stamp: `%ProgramData%\Broadify\vcam.log` logs
   `build_stamp git_sha=... build_time=...` on the first DLL log line. The
   stamp is generated at CMake configure time, so rerun the configure/build
   step before comparing it to a fresh commit.
4. Installer/deploy fallback: if `FrameServer` or `FrameServerMonitor` cannot
   stop while replacing `broadify-vcam.dll`, reboot Windows before validating
   Teams.
