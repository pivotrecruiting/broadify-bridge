# Windows Meeting Keyer

The Windows meeting keyer is a single-path pipeline: one camera frame enters
the helper, segmentation produces one alpha mask, and the compositor combines
camera, background, and graphics in the program loop. IPC/HTTP control changes
policy and tuning; mask pixels stay in the local helper path.

## Tier Selection

Startup chooses one tier and publishes it through
`segmentation_tier_selected`, `keyer_tier_cache`, and `keyer.get`:

| Tier | Runtime path | Availability |
| --- | --- | --- |
| `os_mask` | MediaFoundation camera metadata mask; MODNet keyer is skipped. | Windows camera exposes background segmentation and the mask capability. |
| `modnet_512_ofd` | DirectML/ORT MODNet at 512 input with OFD temporal filtering. | Default Windows fallback. |
| `modnet_320_ofd` | DirectML/ORT MODNet at 320 input with OFD temporal filtering. | Fixed lower tier or auto decision for predicted over-budget systems. |
| `selfie_landscape` | ORT session for converted MediaPipe Selfie Segmenter landscape. | Optional asset present and selected by auto/override. |

If an optional tier is unavailable, the helper falls back to MODNet instead of
reporting a stub keyer. The selfie model is optional; missing asset means that
tier is not selected. The OS-mask tier requires a real MediaFoundation extended
camera control and real frame metadata.

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

Environment knobs:

| Variable | Values |
| --- | --- |
| `BROADIFY_MEETING_KEYER_PRESET` | `balanced`, `sharp`, `soft` |
| `BROADIFY_MEETING_KEYER_TIER` | `auto`, `os_mask`, `modnet_512_ofd`, `modnet_320_ofd`, `selfie_landscape` |
| `BROADIFY_MEETING_KEYER_OFD` | `1` default on Windows, `0` disables OFD |
| `BROADIFY_MEETING_GUIDED_RADIUS` | Integer radius override |
| `BROADIFY_MEETING_GUIDED_EPSILON` | Guided-filter epsilon override |
| `BROADIFY_MEETING_GUIDED_COEFF_EMA` | Coefficient EMA override |
| `BROADIFY_MEETING_MASK_ERODE_PX` | Erode override |
| `BROADIFY_MEETING_MASK_DILATE_PX` | Dilate override |
| `BROADIFY_MEETING_MASK_FEATHER_PX` | Feather override |
| `BROADIFY_MEETING_EDGE_STAB` | `1` or `0` |

Windows MODNet fused EMA defaults to off
(`BROADIFY_MEETING_FUSED_EMA_STATIC=1.0`) because OFD is the primary temporal
flicker fix. Edge stabilization remains off for fused presets by default.

## Field Logs

`segmentation_tier_selected` is emitted once per helper start.
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
| `segmentation_tier_selected` | Startup tier decision and reason. |
| `keyer_policy_change` | Runtime pipeline mode or active performance mode changed. |
| `matting_backend_selected` / `matting_backend_fallback` | Backend factory decision and fallback reason. |

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
