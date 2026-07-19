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
non-macOS platforms it returns `null` and the command reports `cancelled`.

## WebApp

`MeetingRecordingControl` (meeting builder, below the preview panel) drives the
flow through `stores/meeting-engine-store.ts`: pick path -> start -> poll
`meeting_recording_status` every second while active -> stop. Client timeouts
live in `lib/bridge-command-timeouts.ts` (pick_path 135 s for the user-facing
dialog, start 40 s) and must stay above the bridge policy timeouts (130 s /
35 s).

## Not adopted

The prototype's `meeting_recording_toggle` (one-key start/stop with a fixed
`~/Videos/Broadify Recordings/` target) belongs to the Stream Deck feature and
is intentionally not ported.
