# Meeting Field Checklist

Use the helper sidecar event log (`meeting-helper-events.log`) plus
`keyer.get`/`state.get` during a field run.

| Check | Expected | Proving signal |
| --- | --- | --- |
| Teams picture | Broadify Camera shows the program picture; Teams/Zoom quality follows `docs/bridge/support/meeting-apps-teams-zoom.md`. | `camera_native_media_type_selected`, regular `rendered_frames`/VCam client counts in `state.get`, plus Teams call integrity or Zoom Statistics -> Video for sent resolution/fps. |
| Background change | Background switch is visible in under 2 s. | `keyer.get.status.degradation_stage` stays out of `passthrough`; no new `keyer_fallback_change` during the switch. |
| Page flip | Previous page remains visible until the next page is decoded. | `media_page_loaded` for the new path; no blank frame should be visible before that event. |
| Background image (umlaut user) | Uploaded company background is visible on a Windows account whose user name contains a non-ASCII character (e.g. `Jürgen`). | `background_image_loaded` with the file name in `path` (basename only, the directory is never logged); no `background_image_load_failed`. If it fails, `stage`/`errno` name the cause (`open`/2 missing, `open`/22 invalid UTF-8, `decode`/0 undecodable). |
| Camera 1080p | Windows camera opens a 1080p native type when available. | `camera_native_media_type_selected` with `width:1920`, `height:1080`, `fps` near 30. |
| Camera format (macOS) | The chosen device format and frame rate stick after the session starts (Cam Link 4K: 1920x1080 at 30.00003 fps, program fps about 30, not 25). | `camera_format_selected` with `match:"tolerant"` (or `exact`), `applied:true`, `applied_fps` about 30, `reapplied:false`; no `camera_format_apply_failed`. See [Camera capture formats (macOS)](#camera-capture-formats-macos). |
| Recording tick cost (macOS) | Recording does not slow the program loop. | `keyer.get.metrics.recorder_ms <= 3` and `program_frame_ms` unchanged versus idle while recording; no `mailbox_replaced` recorder events; `recording.dropped_frames` stays 0. |
| Recording stop | A stop without frames leaves no `.part` behind. | `recording.last_error:"no_frames"` plus a `no_frames` recorder event; no `<name>.mp4.part` in the target folder. |
| Camera hand-off zero-copy | 1080p capture hand-off does not spend frame budget on RGBA copies. | `keyer.get.metrics.camera_copy_ms <= 0.1` during steady 1920x1080 capture. |
| Budget visible | Program-loop overhead is visible and causes tier/cadence reaction instead of hidden drops. | `frame_overhead_ms` and `budget_threshold_ms` are present; `keyer_budget_overrun` is followed by a tier step or `keyer_budget_recovered` within 2 s. |
| Windows SHM | VCam DLL reaches SHM quickly after helper start. | VCam log transport switches away from TCP; expected within about 3 s when mappings are healthy. |
| macOS keyed continuity | No raw/un-keyed camera frame appears during normal keyer cadence skips. | `keyer_degradation_stage_change` reports `fused`/`no_subject`, plus no unexpected `passthrough`; camera stalls emit `camera_stalled` and `camera_recovered`. |

## Camera capture formats (macOS)

Field finding (4 Nov 2026, Bridge rc.23, Elgato Cam Link 4K with a Blackmagic
Pocket): the preview juddered at about 25 fps in a 30 fps stream even without
a recording. AVFoundation reports the Cam Link's modes as single-rate ranges
`25.0-25.0`, `30.00003000003-30.00003000003`, `50.0-50.0`,
`60.00024000096-60.00024000096`; the former exact `min <= 30 <= max` test
never matched 30.00003, so nothing was configured and the device stayed at its
25 fps default.

Rules (`src/capture/capture_format_selection.{h,cpp}`, unit-tested in
`capture_format_selection_test`):

- A range matches *exactly* when it contains the requested rate, and
  *tolerantly* when it contains it within `kFpsTolerance = 0.01` fps (covers
  30.00003 / 60.00024; 29.97 is a different rate and goes through the
  nearest fallback). Among matches the resolution is scored as before
  (absolute width/height delta, 1e6 penalty below the target).
- Without a match the closest supported rate across all formats wins
  (25/50-only device asked for 30 gets 25; equal distance prefers the higher
  rate), then the resolution score. `none` only when the device lists no
  usable format; the session preset path remains the fallback.
- The frame duration is taken from the chosen range's own `CMTime` values
  (never `CMTimeMake(1, 30)` for a 30.00003 range: AVFoundation throws for a
  duration outside the range; the set is guarded and a
  `camera_format_apply_failed` event replaces a crash).
- Order: `addInput` → session preset (`1280x720` / `1920x1080`) → lock,
  `activeFormat` + `activeVideoMin/MaxFrameDuration`, unlock → `startRunning`
  → read back `activeFormat` / `activeVideoMinFrameDuration`; if the session
  reset them, apply once more (`reapplied:true`). The iOS rule that a preset
  and `activeFormat` are mutually exclusive (`AVCaptureSessionPresetInputPriority`)
  does not exist on macOS, which is why the read-back is the proof.

Event (one per camera open, in `meeting-helper-events.log`):

```json
{"type":"camera_format_selected","camera_index":0,"width":1920,"height":1080,"fps":30.00003,"pixel_format":"420v","requested_width":1920,"requested_height":1080,"requested_fps":30,"match":"tolerant","applied":true,"reapplied":false,"applied_width":1920,"applied_height":1080,"applied_fps":30.00003,"applied_pixel_format":"420v","session_preset":"AVCaptureSessionPreset1920x1080"}
```

`match:"none"` reports the device's active format instead. List a device's
formats and ranges by hand:

```bash
swift -e 'import AVFoundation; for d in AVCaptureDevice.devices(for: .video) { print(d.localizedName); for f in d.formats { let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription); print("  \(dim.width)x\(dim.height)", f.videoSupportedFrameRateRanges.map { "\($0.minFrameRate)-\($0.maxFrameRate)" }) } }'
```
