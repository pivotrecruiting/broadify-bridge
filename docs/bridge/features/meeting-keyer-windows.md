# Windows Meeting Keyer

The Windows meeting keyer is a single-path pipeline: one camera frame enters
the helper, segmentation produces one alpha mask, and the compositor combines
camera, background, and graphics in the program loop. IPC/HTTP control changes
policy and tuning; mask pixels stay in the local helper path.

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
       - with a VCam client connected, fused cadence can be pinned to every
         frame by tuning; the governor steps 512 -> 320 -> 256 before
         async-lite, and async-lite requires sustained over-budget samples at
         fused 256
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

## Tier Selection

After a camera is attached, the helper chooses one tier and publishes it
through `segmentation_tier_selected` and `keyer.get`:

| Tier | Runtime path | Availability |
| --- | --- | --- |
| `os_mask` | MediaFoundation camera metadata mask; MODNet keyer is skipped. | Windows camera exposes background segmentation and the mask capability. |
| `modnet_512_ofd` | DirectML/ORT MODNet at 512 input with OFD temporal filtering. | Default Windows fallback. |
| `modnet_320_ofd` | DirectML/ORT MODNet at 320 input with OFD temporal filtering. | Fixed lower tier or auto decision for predicted over-budget systems. |
| `selfie_landscape` | ORT session for converted MediaPipe Selfie Segmenter landscape. | Optional asset present and selected by auto/override. |

If an optional tier is unavailable, the helper selects a MODNet tier instead of
reporting a stub keyer. The selfie model is optional; missing asset means that
tier is not selected. The OS-mask tier requires a real MediaFoundation extended
camera control; when an OS-mask-selected frame has no mask metadata blob, that
frame is keyed through MODNet rather than rendered un-keyed.

## OS Mask

The OS-mask path attaches to the `IMFMediaSource` used by the active
MediaFoundation source reader. It obtains `IMFExtendedCameraController` from
the source service, requests
`KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION`, checks
`KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK`, then commits either
`MASK` or `OFF`.

Frame metadata is read from `MFSampleExtension_CaptureMetadata` and
`MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK`. The helper maps
`KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK` by treating
`MaskCoverageBoundingBox` as the frame-space region covered by the mask and
`ForegroundBoundingBox` as the only region that may receive foreground alpha.
Pixels outside that foreground box are background.

## Auto Degradation

The fused MODNet governor steps down through 512 -> 320 -> 256 -> async-lite ->
off-reduced. On Windows fused step-downs are gated behind a sustained
over-budget window, and step-up requires a 60 s stable dwell. The fixed
`modnet_320_ofd` tier bypasses the governor and drives the MODNet `balanced`
input size directly.

## Tuning

`keyer.get` returns `tuning` with the effective values and `source`
(`default`, `env`, or `webapp`). The webapp can update the bridge contract with
`keyer.configure {"preset":"balanced|sharp|soft"}`; no UI is added in WP5.

| Preset | Use | Guided radius | Guided eps | OFD near/far | Dilate | Feather |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `balanced` | Default field profile | 4 | 0.002 | 8 / 24 | 1 | 1 |
| `sharp` | Crisper edge, less smoothing | 3 | 0.0012 | 6 / 20 | 0 | 0 |
| `soft` | Noisier cameras, more forgiveness | 6 | 0.004 | 10 / 30 | 2 | 2 |

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `BROADIFY_MEETING_GPU_PIPELINE` | `1` | Enables the fused Windows GPU keyer path. Set `0` for async worker path. |
| `BROADIFY_MEETING_AUTO_DEGRADE` | `1` | Enables the fused tier governor. |
| `BROADIFY_MEETING_WARM_HANDOVER` | `1` | Keeps make-before-break transitions between fused and async-lite. |
| `BROADIFY_MEETING_KEYER_PREBUILD_TIERS` | `active,256` | Prebuilds the current high tier plus 256 on first load. Accepts `all`, `active`, `512`, `320`, `256`, or mode names in a comma list. |
| `BROADIFY_MEETING_DML_QUEUE` | `compute` | DirectML DML1 command queue type. Use `direct` for A/B against rc.21. |
| `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` | unset | Overrides the governor step-down threshold for tests/tuning. |
| `BROADIFY_MEETING_KEYER_CADENCE` | `auto` | Auto cadence, `0` disabled, or integer frame interval. Auto defaults to maxN 2 and motion threshold 4. |
| `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH` | `1` | Enables cadence reuse of retained fused masks. |
| `BROADIFY_MEETING_FUSED_POSTPROCESS` | `1` | Applies the postprocess chain on fused masks. |
| `BROADIFY_MEETING_FUSED_SMOOTHER` | `ema` | `ema` uses motion-adaptive EMA and disables edge stabilization for fused masks; `edge` uses edge stabilization instead. |
| `BROADIFY_MEETING_FUSED_EMA_STATIC` | `1.0` | Static-subject EMA weight for fused-mask stabilization on Windows. |
| `BROADIFY_MEETING_FUSED_EMA_MOTION` | `1.0` | Motion EMA weight for fused-mask stabilization on Windows. |
| `BROADIFY_MEETING_MASK_WORK_WIDTH` | `512` | Guided-refine/postprocess work width cap. 16:9 defaults to 512x288. |
| `BROADIFY_MEETING_KEYER_PRESET` | `balanced` | `balanced`, `sharp`, or `soft` tuning preset. |
| `BROADIFY_MEETING_KEYER_TIER` | `auto` | `auto`, `os_mask`, `modnet_512_ofd`, `modnet_320_ofd`, or `selfie_landscape`. |
| `BROADIFY_MEETING_KEYER_OFD` | `1` | Enables OFD temporal filtering on Windows; set `0` to disable. |
| `BROADIFY_MEETING_GUIDED_RADIUS` | `4` | Guided-filter radius for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_EPSILON` | `5e-4` | Guided-filter epsilon for D3D11 and CPU fallback. |
| `BROADIFY_MEETING_GUIDED_COEFF_EMA` | `0` | D3D11 guided-filter coefficient EMA; default off to avoid silhouette trails. |
| `BROADIFY_MEETING_GPU_GUIDED` | `1` | Enables D3D11 guided refine; set `0` for CPU fallback. |
| `BROADIFY_MEETING_CAMERA_MAX_HEIGHT` | `720` | Clamps Windows MediaFoundation camera requests and reopen attempts to <=720p at <=30 fps. |
| `BROADIFY_MEETING_EMPTY_SUBJECT` | `1` | Allows confirmed-empty subject masks after 400 ms below the foreground floor. |
| `BROADIFY_MEETING_KEYER_DML_LEGACY` | unset | Forces legacy DirectML device 0 selection. |

Windows MODNet fused EMA defaults to off
(`BROADIFY_MEETING_FUSED_EMA_STATIC=1.0` and
`BROADIFY_MEETING_FUSED_EMA_MOTION=1.0`) because OFD is the primary temporal
flicker fix. Edge stabilization remains off for fused presets by default.

## Field A/B

| Scenario | Env | Expected discriminator |
| --- | --- | --- |
| rc.18-style DML queue | `BROADIFY_MEETING_DML_QUEUE=compute` | Lower compositor contention; default. |
| rc.21 queue comparison | `BROADIFY_MEETING_DML_QUEUE=direct` | Direct queue can compete with D3D11 compositor on weak GPUs. |
| Governor disabled | `BROADIFY_MEETING_AUTO_DEGRADE=0` | `keyer_pipeline_mode` stays fused/fused_cadence unless the keyer fails. |
| No fused cadence reuse | `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` | `metrics.mask_age_ms` stays near 0 on fused frames. |
| Prebuild only 256 | `BROADIFY_MEETING_KEYER_PREBUILD_TIERS=256` | First-load memory lower; step-up to missing tiers cannot warm. |

## Status And Logs

`segmentation_tier_selected` is emitted after camera attach and can be emitted
once more when the first MODNet 320 warm-up probe refines the auto decision.
`keyer.get.status.keyer_tier` mirrors the active selection:

| Value | Meaning |
| --- | --- |
| `os_mask` | Windows OS background mask selected. |
| `modnet_512_ofd` | Default MODNet 512 with OFD. |
| `modnet_320_ofd` | Fixed lower MODNet tier with OFD. |
| `selfie_landscape` | Optional MediaPipe landscape backend. |

`keyer_tier_reason` is the diagnostic field to compare across machines, for
example `windows_os_mask_capability`, `windows_modnet_default`, or
`igpu_modnet320_over_budget`.

Log lines to collect in field reports:

| Event | Purpose |
| --- | --- |
| `windows_os_mask_probe` | Per-camera OS-mask property/capability probe. |
| `segmentation_tier_selected` | Camera-attached tier decision and reason. |
| `keyer_policy_change` | Runtime pipeline mode or active performance mode changed. |
| `matting_backend_selected` / `matting_backend_fallback` | Backend factory decision and fallback reason. |

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

## Assets And Selftests

`models/manifest.json` declares `modnet.onnx` as required and
`selfie_landscape.onnx` as optional. The selfie source is the official
MediaPipe Selfie Segmenter landscape TFLite model:

```bash
bash scripts/prepare-selfie-segmenter-model.sh
```

The script downloads the official TFLite by default, optionally verifies
`SELFIE_SEGMENTER_TFLITE_SHA256`, converts to ONNX, and prints the converted
SHA-256 for the manifest once release packaging adopts that asset.

Windows packaged smoke runs:

```powershell
scripts/test-windows-meeting-helper.ps1 -HelperPath <helper.exe> -ModelsDir <models>
```

That smoke includes `--keyer-tier-selftest`, which must emit
`keyer_tier_selftest` with `ok:true`.
