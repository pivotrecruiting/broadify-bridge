# Meeting Recording

Records the composited meeting program (the same frames that go to the virtual
camera) plus a selected microphone into an `.mp4` on the bridge machine.

## Architecture

- Data plane: the meeting helper's frame pipeline taps every composited program
  frame (`recorder.appendVideoFrame`) after rendering, before the FrameBus
  write. The tap is a no-op while no recording is active.
- Encoder: `apps/bridge/native/meeting-helper/src/recorder/`
  - macOS: AVFoundation (`meeting_recorder.mm`), H.264 + AAC.
  - Windows: Media Foundation (`meeting_recorder_mediafoundation.cpp`).
  - Other platforms: stub (`meeting_recorder_stub.cpp`), recording unsupported.
- Control plane: helper JSON-RPC methods `recording.microphones`,
  `recording.start`, `recording.stop`, `recording.status`
  (`src/control/control_server.cpp`), forwarded by
  `apps/bridge/src/services/meeting/meeting-helper-client.ts`.

## Relay commands

Allowlisted in `relay-command-allowlist.ts`, policies in
`relay-command-policy.ts`, handled in `meeting-command-handler.ts`:

| Command | Kind | Payload | Result data |
| --- | --- | --- | --- |
| `meeting_recording_microphones` | read only | none | `{ microphones: [{ device_id, label, is_default }] }` |
| `meeting_recording_pick_path` | side effect | `{ default_name? }` | `{ cancelled, file_path? }` |
| `meeting_recording_start` | side effect | `{ file_path, mic_device_id? }` | `{ recording: {...} }` |
| `meeting_recording_stop` | side effect | none | `{ recording: {...} }` |
| `meeting_recording_status` | read only | none | `{ recording: {...} }` |

`recording` status shape: `{ active, file_path, elapsed_seconds, video_frames,
last_error }` (snake_case, as produced by the helper).

`meeting_recording_pick_path` opens the native macOS save panel on the bridge
machine via osascript (`meeting-recording-dialog.ts`); the file is written
locally by the helper, so the location cannot be chosen in the browser. On
non-macOS platforms (no native save panel wired up) it falls back to
`buildDefaultRecordingPath()` — a timestamped file in the user's standard
Videos/Movies folder — instead of returning `null`, which the webapp would
treat as a user cancel and silently never start.

## File lifecycle (macOS)

The writer targets `<final>.mp4.part` and the sidecar is renamed to the final
path only after `finishWriting` reports Completed (REC-03) — a crash or
finalize failure never leaves a half-written file under the chosen name. The
writer is built by `recorder_writer_factory.mm` (shared with
`meeting_recorder_writer_test` so ctest exercises the exact shipped
configuration). Periodic movie fragments (`movieFragmentInterval`, added Jul
2026 for crash safety) were removed in Aug 2026: every real recording longer
than ~8 s died at a fragment commit while the same configuration survives
isolated stress runs — the pre-fragment configuration has hours of successful
field recordings. Recorder incidents (`writer_failed`, `finish_failed`,
`finalize_timeout`, `rename_failed`, `completed`) are emitted as
`{"type":"meeting_recorder",...}` events through the helper event log
(`util/helper_event_log`): stdout plus the `--event-log` sidecar file
(`meeting-helper-events.log` in the bridge user-data dir). The sidecar matters
on macOS, where the `open`-based launch swallows helper stdio; the bridge
forwards stdout lines when it can (`meeting-helper-manager.ts`) and dumps the
sidecar tail into its process log whenever the helper dies unexpectedly.

## File lifecycle (Windows)

The Media Foundation recorder also writes to `<final>.mp4.part` first and only
renames it after `Finalize()` succeeds. The Windows container remains
fragmented MP4, so a hard kill can still leave playable fragments in the
sidecar while the final path is reserved for completed recordings.

## Encoding

Meeting recordings use H.264 High Profile plus AAC audio. Video bitrate is set
from a shared native policy at 0.35 bit/px and clamped to 2-40 Mbit/s: 1080p30
lands at about 21.8 Mbit/s, which is roughly 10 GB/h including audio and
container overhead. GOP/keyframes are targeted at two seconds (`fps * 2`),
frame reordering is disabled, and macOS requests CABAC.

Video timestamps are written on a constant-frame-rate grid relative to the
writer session start. If the program frame source arrives late, the recorder
fills up to four missing frame slots with the latest frame. Gaps longer than
one second jump to the current grid position and emit one recorder event for
diagnostics. Encoder backpressure only commits frames that were actually
written, so unfilled slots are retried on the next program frame. Set
`BROADIFY_MEETING_RECORDER_CFR=0` to restore the legacy host-clock video PTS
path for diagnosis.

Both platform writers tag video as BT.709. macOS sets AVFoundation color
properties on the video settings and pixel buffers; Windows sets BT.709
matrix, transfer function, primaries and limited-range output media type while
keeping the RGB input range full-range.

Quick probe after recording:

```bash
ffprobe -hide_banner -select_streams v:0 -show_entries stream=codec_name,profile,bit_rate,avg_frame_rate,r_frame_rate,color_space,color_transfer,color_primaries -of default=noprint_wrappers=1 recording.mp4
```

## WebApp

`MeetingRecordingControl` (meeting builder, below the preview panel) drives the
flow through `stores/meeting-engine-store.ts`: pick path -> start -> poll
`meeting_recording_status` every second while active -> stop. Client timeouts
live in `lib/bridge-command-timeouts.ts` (pick_path 135 s for the user-facing
dialog, start 40 s) and must stay above the bridge policy timeouts (130 s /
35 s).

## Stream Deck

`meeting_recording_toggle` (one-key start/stop with a default recording path,
no save dialog) exists for the Stream Deck REC key and shares the same helper
recorder.
