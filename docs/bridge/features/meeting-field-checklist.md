# Meeting Field Checklist

Use the helper sidecar event log (`meeting-helper-events.log`) plus
`keyer.get`/`state.get` during a field run.

| Check | Expected | Proving signal |
| --- | --- | --- |
| Teams picture | Broadify Camera shows the program picture. | `camera_native_media_type_selected` and regular `rendered_frames`/VCam client counts in `state.get`. |
| Background change | Background switch is visible in under 2 s. | `keyer.get.status.degradation_stage` stays out of `passthrough`; no new `keyer_fallback_change` during the switch. |
| Page flip | Previous page remains visible until the next page is decoded. | `media_page_loaded` for the new path; no blank frame should be visible before that event. |
| Camera 1080p | Windows camera opens a 1080p native type when available. | `camera_native_media_type_selected` with `width:1920`, `height:1080`, `fps` near 30. |
| Windows SHM | VCam DLL reaches SHM quickly after helper start. | VCam log transport switches away from TCP; expected within about 3 s when mappings are healthy. |
| macOS keyed continuity | No raw/un-keyed camera frame appears during normal keyer cadence skips. | `keyer_degradation_stage_change` reports `fused`/`no_subject`, plus no unexpected `passthrough`; camera stalls emit `camera_stalled` and `camera_recovered`. |
