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
audio_samples_written, audio_samples_dropped, last_error }` (snake_case, as
produced by the helper). The two `audio_samples_*` counters are additive
diagnostics (Oct 2026): numbers on Windows, `null` on macOS and the stub — see
[Audio diagnostics](#audio-diagnostics-mute-recordings) below.

`meeting_recording_pick_path` opens the native macOS save panel on the bridge
machine via osascript (`meeting-recording-dialog.ts`); the file is written
locally by the helper, so the location cannot be chosen in the browser. On
non-macOS platforms (no native save panel wired up) it falls back to
`buildDefaultRecordingPath()` — a timestamped file in the shared default
recordings folder — instead of returning `null`, which the webapp would
treat as a user cancel and silently never start.

### Default recording path (one folder for every trigger)

`apps/bridge/src/services/shared/recording-paths.ts` is the single source of
truth for default recording locations. Every trigger that has no save dialog
(non-macOS save-panel fallback, Stream Deck REC toggle, PGM recording without
an explicit `file_path`) writes into the same folder:

| Platform | Folder | Meeting file | PGM file |
| --- | --- | --- | --- |
| macOS, Linux | `~/Movies/Broadify` | `Broadify-Meeting-<YYYY-MM-DD_HH-mm-ss>.mp4` | `Broadify-PGM-<stamp>.mp4` |
| Windows | `~/Videos/Broadify` | same | same |

The folder is created best effort (sync `mkdir -p`) before the path is handed
to the helper; the recorders do not create directories themselves. The result
is always an absolute `.mp4` path without parent traversal, so it passes the
relay boundary's `isSafeRecordingPath` guard.

### macOS folder consent (Info.plist)

The helper writes wherever the operator points the save panel — `~/Documents`,
`~/Desktop`, `~/Downloads`, external or network volumes included. macOS only
shows its folder consent prompt when the helper bundle declares the matching
usage strings, otherwise the write fails with a bare permission error. The
meeting helper's `macos/Info.plist` therefore declares
`NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`,
`NSDownloadsFolderUsageDescription`, `NSRemovableVolumesUsageDescription` and
`NSNetworkVolumesUsageDescription` next to the camera/microphone strings (the
PGM helper declares the same set). `scripts/verify-macos-release-signing.sh`
fails closed when any of them is missing from the packaged bundle, and
`scripts/meeting-helper-release-contract.test.cjs` guards the source plists.

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
sidecar while the final path is reserved for completed recordings. The same
recorder events as on macOS (`finish_failed`, `finalize_timeout`,
`rename_failed`, plus the Windows-only `audio_stats`, see below) go through the
helper event log.

## Finalize timeout (both platforms)

`stop()` runs on the helper's sequential control thread, and the bridge gives
the `recording.stop` RPC 20 s (`MEETING_HELPER_RPC_TIMEOUTS_MS` in
`apps/bridge/src/services/meeting/meeting-helper-timeouts.ts`). A client timeout
does not cancel helper-side work, so a finalize that never returns used to leave
the helper stuck while the bridge already reported failure (stream deck stuck on
"REC", every later RPC queued behind it). Both recorders therefore bound the
finalize step with the shared `kRecorderFinalizeTimeoutMs` (15 000 ms,
`src/recorder/recorder_encode_policy.h`), which must stay below the RPC timeout;
`scripts/meeting-helper-release-contract.test.cjs` parses both values and fails
when they drift.

- macOS: `finishWritingWithCompletionHandler` signals a semaphore; the control
  thread waits at most `kRecorderFinalizeTimeoutMs`.
- Windows: `IMFSinkWriter::Finalize()` runs on a detached worker thread that
  owns its own COM apartment and the last writer reference; the control thread
  waits on a `std::future` for at most `kRecorderFinalizeTimeoutMs`. On timeout
  the control thread never touches the writer again; the worker releases it
  whenever `Finalize` eventually returns.

On timeout both platforms emit `{"type":"meeting_recorder","event":
"finalize_timeout","detail":"... exceeded 15000ms ..."}`, set
`recording.last_error = "finalize_timeout"` and do NOT rename the `.part`
sidecar (REC-03: only a fully finalized file gets the real name). The sidecar
is still an fMP4 with every committed fragment, so the recording is recoverable
by hand (`ffmpeg -i x.mp4.part -c copy x.mp4`), but it never masquerades as a
finished file.

## Audio diagnostics (mute recordings)

The Windows recorder admits microphone samples through the shared
`RecorderAudioRebase` policy (`recorder_encode_policy.h`, unit-tested in
`recorder_encode_policy_test`): a sample whose MF timestamp lies before the
writer session start (`sessionStartHns`, taken right after `BeginWriting`) is
dropped, everything at/after it is written with the timestamp rebased to the
session. That is the pre-existing behaviour; what is new is that both outcomes
are counted and surfaced:

- `{"type":"meeting_recorder","event":"audio_stats","detail":"written=<n>
  dropped_before_start=<m>"}` is emitted once per `stop()` (helper stdout +
  `meeting-helper-events.log` sidecar).
- `recording.audio_samples_written` / `recording.audio_samples_dropped` carry
  the same counters live in `recording.status` (and therefore in the bridge
  status snapshot); they reset on `recording.start`.

Reading them for the "Windows recording is mute" report:

| `written` | `dropped_before_start` | Meaning |
| --- | --- | --- |
| 0 | 0 | The capture device never delivered a sample (idle virtual endpoint, wrong device, driver stall). Only the 10 ms silence primer is in the file. |
| 0 | large | Every sample arrived with a timestamp before the session start: the capture clock runs ahead of/behind `MFGetSystemTime()`. Candidate for the rebase-instead-of-drop change (`RecorderAudioRebase::rebase` already computes the offset). |
| small | large | The first seconds are missing, the rest is there. Same clock-offset cause, partial. |
| about 100 per recorded second (10 ms capture buffers) | 0 or a handful | Audio reached the writer; a mute file points at the AAC encoder/sink, not at capture. |

The behaviour change (clamping early samples to t=0 instead of dropping them)
is deliberately not shipped until a Windows measurement of these counters
shows which case occurs in the field. macOS does not fill the counters (its
capture delegate does the same before-start drop; adding counters there is a
separate change).

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
recorder. The file goes to the shared default recordings folder described
above (`~/Movies/Broadify` on macOS, `~/Videos/Broadify` on Windows) as
`Broadify-Meeting-<stamp>.mp4` — the same place and naming as the save-panel
fallback. Before Oct 2026 the toggle wrote `~/Videos/Broadify Recordings/
meeting-<iso-stamp>.mp4` on every platform, i.e. a different folder than the
other triggers and a Windows-style path on macOS.
