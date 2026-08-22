# Windows Meeting Keyer

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
