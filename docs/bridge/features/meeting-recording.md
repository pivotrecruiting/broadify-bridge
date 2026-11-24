# Meeting Recording

Records the composited meeting program (the same frames that go to the virtual
camera) plus a selected microphone into a file on the bridge machine: H.264 or
HEVC in `.mp4`, ProRes 422 LT / 422 / HQ in `.mov` (see
[Recording format](#recording-format-codec-and-container-adr-0010)).

## Architecture

- Data plane: the meeting helper's frame pipeline taps every composited program
  frame (`recorder.appendVideoFrame`) after rendering, before the FrameBus
  write. The tap is a no-op while no recording is active.
- Encoder: `apps/bridge/native/meeting-helper/src/recorder/`
  - macOS: AVFoundation (`meeting_recorder.mm`), every codec of the recording
    format.
  - Windows: Media Foundation (`meeting_recorder_mediafoundation.cpp`), H.264 +
    AAC only; every other codec is refused.
  - Other platforms: stub (`meeting_recorder_stub.cpp`), recording unsupported.
  - `MeetingRecorder::start` takes one `RecordingRequest` (file path,
    microphone, program geometry, codec) on every platform.
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
| `meeting_recording_pick_path` | side effect | `{ default_name?, locale?, codec? }` | `{ cancelled, file_path? }` |
| `meeting_recording_start` | side effect | `{ file_path, mic_device_id?, codec? }` | `{ recording: {...} }` |
| `meeting_recording_stop` | side effect | none | `{ recording: {...} }` |
| `meeting_recording_toggle` | side effect | `{ mic_device_id?, codec? }` | `{ recording: {...} }` |
| `meeting_recording_status` | read only | none | `{ recording: {...} }` |
| `meeting_recording_upload_configure` | side effect | `{ enabled }` (strict) | `{ upload: {...} }` |

`codec` is a `MeetingRecordingCodecT` and optional everywhere; without it the
recording is `h264`. The start schema is strict, so the web app sends `codec`
only to a bridge that reports `capabilities.meeting.recording_probe` (a
bridge that knows the field and checks it, see
[Every recording is what is configured](#every-recording-is-what-is-configured)). The extension
of `file_path` must be the container of the codec (`.mp4` or `.mov`),
otherwise the payload is invalid. `codec` is validated as a name, not against
this bridge's list: a name it does not know (a newer web app) is refused with
`meeting_recording_codec_unsupported` like any codec that is not advertised.
A client that records with a codec sends the same `codec` to
`meeting_recording_pick_path` and to `meeting_recording_start`: without it the
panel enforces `.mp4`, and a ProRes start with that path is an invalid
payload.

`recording` status shape: `{ active, file_path, codec, container,
elapsed_seconds, video_frames, dropped_frames, queued_frames,
audio_samples_written, audio_samples_dropped, disk_space_low, last_error }`
(snake_case, as produced by the helper). `codec` / `container` name the format
of the current or last recording and are `null` before the first start.
`disk_space_low` is `null`, or `{ required_bytes, free_bytes }` after a start
that was refused with `recording_disk_space_low`. The two
`audio_samples_*` counters are additive diagnostics (Oct 2026): numbers on
Windows only. macOS and the stub always report `null`, also while audio is
being recorded: `null` means "not counted", not "no audio" — see
[Audio diagnostics](#audio-diagnostics-mute-recordings) below.
`last_error` is the error of the current or last recording, or of the last
failed start; it is empty after a recording that finalized cleanly. A start
refused with `already_recording` does not touch it.
`dropped_frames` / `queued_frames` (Nov 2026, always numbers) count program
frames the recorder could not encode (encoder backpressure; on macOS also
frames the recorder mailbox replaced because the worker thread fell behind)
and frames waiting in that mailbox right now (Windows/stub: 0). All of
`elapsed_seconds`, `video_frames`, `dropped_frames`, `queued_frames` and the
audio counters are volatile for the bridge's status-publish policy
(`status-publish-policy.ts`), i.e. they never trigger a publish on their own.

`meeting_recording_pick_path` opens the native macOS save panel on the bridge
machine via osascript (`meeting-recording-dialog.ts`); the file is written
locally by the helper, so the location cannot be chosen in the browser. The
panel proposes and enforces the extension of the codec's container: a name
without it gets it appended, a name with the other recording extension gets
it replaced (`take.mp4` becomes `take.mov` for ProRes). A `codec` the start
would refuse is refused here already, before the panel opens. On
non-macOS platforms (no native save panel wired up) it falls back to
`buildDefaultRecordingPath()` — a timestamped file in the shared default
recordings folder — instead of returning `null`, which the webapp would
treat as a user cancel and silently never start.

### Every recording is what is configured

A recording is written with the codec that was requested, or it does not
start. No trigger ever records another codec than the configured one, and
there is no fallback to H.264.

- **Source of truth:** the codec saved on the web app's recording-format page
  (web database; nothing is persisted on the bridge). Absent means `h264`,
  which is sent as "no `codec` field".
- **Triggers** (there are two; no hotkey, no autostart, no other bridge-local
  trigger): the web record button sends `codec` in
  `meeting_recording_pick_path` and `meeting_recording_start`. The Stream
  Deck REC key runs `meeting_recording_toggle` on the bridge without the web
  app; the web app stamps `codec` into the payload of that key's binding and
  pushes the mapping (`streamdeck_configure`), which the bridge persists, so
  the key records the configured codec with the web app closed and after a
  bridge restart. See [Stream Deck](#stream-deck).
- **Arbiter:** `gateRequestedRecordingCodec` in `meeting-command-handler.ts`,
  the same for all three commands. A request with `codec` is refused with
  `meeting_recording_codec_unsupported` unless the codec is in
  `capabilities.meeting.recording.codecs` **and** covers the running program
  (`min(width, height) <= max_height` and `fps <= max_fps`; without a running
  program only the name is checked). The refusal carries
  `data { codec, reason }`:

  | `reason` | Meaning |
  | --- | --- |
  | `encoder_unavailable` | The encoder probe has a result and the codec is not in it (no hardware encoder, not written on this platform, or a name this bridge does not know). |
  | `program_format_exceeded` | The codec is available but does not record the running program's size or frame rate. |
  | `encoders_unknown` | The encoder probe failed, or has still no result after the gate waited for it. |

  If the probe has not settled, the gate waits for the attempt in flight
  (starting one if none runs - a key press right after the bridge started,
  with no web app connected, has had no `get_status` to start it), bounded by
  the probe's 5 s timeout. A request without `codec` is never gated: it is
  the H.264 recording every older client gets, and the helper holds it to a
  hardware encoder itself.
- **Why refuse instead of "H.264 with a notice":** a notice cannot be
  guaranteed on the Stream Deck (the key has no text and the web app may be
  closed), so a fallback there would be silent. A refusal is visible at once
  with what exists: the key flashes red, REC does not come on, the web app
  shows the `streamdeck_error` (now with `error_code`), the record button its
  error line. A file in the wrong codec is found hours later and cannot be
  repaired; a refused start is fixed with one click on the format page.
- **Known limit:** the copy in the key binding is refreshed only by a web
  session connected to this bridge. A codec change made while none is
  connected reaches the deck on the next connect. A bridge older than this
  package (no `recording_probe` in its capabilities) is not stamped by the
  web app; its key records H.264.

### Default recording path (one folder for every trigger)

`apps/bridge/src/services/shared/recording-paths.ts` is the single source of
truth for default recording locations. Every trigger that has no save dialog
(non-macOS save-panel fallback, Stream Deck REC toggle, PGM recording without
an explicit `file_path`) writes into the same folder:

| Platform | Folder | Meeting file | PGM file |
| --- | --- | --- | --- |
| macOS, Linux | `~/Movies/Broadify` | `Broadify-Meeting-<YYYY-MM-DD_HH-mm-ss>.<ext>` | `Broadify-PGM-<stamp>.mp4` |
| Windows | `~/Videos/Broadify` | same | same |

`<ext>` is the container of the meeting recording's codec (`mp4` or `mov`); a
PGM recording is always `.mp4`. The folder is created best effort (sync
`mkdir -p`) before the path is handed to the helper; the recorders do not
create directories themselves. The result is always an absolute path with
that extension and without parent traversal, so it passes the relay
boundary's `isSafeRecordingPath` guard.

### Error codes of a recording start

`meeting_recording_start` and `meeting_recording_toggle` answer a refused
start with `success: false` and one of these `errorCode`s (the native
recorder reports a token as the message of `recording_start_failed`;
`RECORDING_ERROR_TOKENS` in `meeting-command-handler.ts` promotes it):

| `errorCode` | Meaning | `data` |
| --- | --- | --- |
| `meeting_recording_codec_unsupported` | The requested codec cannot be recorded right now: refused by the bridge before the helper is asked (see [Every recording is what is configured](#every-recording-is-what-is-configured)), or the helper has no hardware encoder for it. Also the code of a refused `meeting_recording_pick_path`. | `{ codec, reason }` from the bridge gate (`encoder_unavailable`, `program_format_exceeded`, `encoders_unknown`); none when the helper refuses |
| `recording_disk_space_low` | The target volume has less free space than the codec needs for five minutes (see [Free disk space](#free-disk-space)). Replaces `disk_full` as the code; the `error` message of this refusal is still the token `disk_full`, because web apps released before this code map only that token and read it from the message too. | `{ required_bytes, free_bytes }` |
| `microphone_permission_denied`, `microphone_not_found`, `microphone_input_failed`, `microphone_input_rejected`, `writer_create_failed`, `already_recording`, `invalid_arguments` | unchanged | none |

`already_recording` (a start while a recording runs or is starting) is
reported in the answer of the refused command only. The recorder state
belongs to the recording that runs: `claimRecordingStart`
(`recorder/recorder_start_claim.h`, shared by both platform recorders,
`recorder_start_claim_test`) refuses without writing anything, and
`MeetingRecorder::start` returns `RecordingStartOutcome::AlreadyRecording`
for the control server to report. Until Nov 2026 the refusal was written to
`recording.last_error` and stayed there after the recording had finished
cleanly.

Any other failure keeps `errorCode: "recording_start_failed"` with the
platform's message. A `codec` that is not a name (empty, not a string) is an
invalid payload, like any other schema violation; on the helper RPC it is
refused with the codec token, never recorded as H.264.

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

The writer targets `<final>.part` (`take.mp4.part`, `take.mov.part`) and the
sidecar is renamed to the final path only after `finishWriting` reports
Completed (REC-03) — a crash or
finalize failure never leaves a half-written file under the chosen name. The
writer is built by `recorder_writer_factory.mm` (shared with
`meeting_recorder_writer_test` so ctest exercises the exact shipped
configuration). Periodic movie fragments (`movieFragmentInterval`, added Jul
2026 for crash safety) were removed in Aug 2026: every real recording longer
than ~8 s died at a fragment commit while the same configuration survives
isolated stress runs — the pre-fragment configuration has hours of successful
field recordings. Recorder incidents (`writer_failed`, `finish_failed`,
`finalize_timeout`, `rename_failed`, `no_frames`, `mailbox_replaced`,
`cfr_drop`, `cfr_discontinuity`, `completed`) are emitted as
`{"type":"meeting_recorder",...}` events through the helper event log
(`util/helper_event_log`): stdout plus the `--event-log` sidecar file
(`meeting-helper-events.log` in the bridge user-data dir). The sidecar matters
on macOS, where the `open`-based launch swallows helper stdio; the bridge
forwards stdout lines when it can (`meeting-helper-manager.ts`) and dumps the
sidecar tail into its process log whenever the helper dies unexpectedly.

### Encode worker thread and frame mailbox (Nov 2026)

Field measurement (Bridge rc.23, M1 Pro, Cam Link 4K): while recording, the
program tick's `program_frame_ms` median rose from 2–6 ms to 27.5 ms (max
68 ms) because `appendVideoFrame` did the RGBA→BGRA swizzle, the CFR planning
and `appendPixelBuffer` synchronously on the program thread. The macOS
recorder now splits the work:

- `MeetingRecorder::appendVideoFrame` (pipeline thread) only takes the
  capture time (`host clock − session start`) and copies the RGBA frame into
  a `RecorderFrameMailbox` (`src/recorder/recorder_frame_mailbox.{h,cpp}`,
  stdlib, unit-tested): single-producer/single-consumer, latest wins (a full
  mailbox replaces its oldest pending frame), buffers recycled by swapping
  so steady state allocates nothing. The capacity follows the frame rate
  (`capacityForFps`: `max(2, ceil(fps / 15))`, i.e. 2 at 25/30 fps and 4 at
  50/60 fps), so the encoder has about 66 ms of slack at every rate. The copy of one 8.3 MB
  1080p frame measured 0.18 ms median / 0.23 ms p95 (memcpy) versus
  0.19 ms median but a 5.6 ms tail for the alternative of swizzling into a
  pooled CVPixelBuffer on the tick thread, which is why the mailbox copies
  RGBA and the swizzle moved off the tick.
- `RecorderVideoWorker` (`src/recorder/recorder_video_worker.{h,mm}`), one
  `std::thread` per recording started in `start()`: takes frames from the
  mailbox, swizzles into the adaptor's pixel-buffer pool, plans the CFR grid
  with the frame's CAPTURE time (never the worker's own clock, so a slow
  encoder shifts nothing on the timeline), waits up to one frame interval
  for `isReadyForMoreMediaData` (the inline path dropped immediately) and
  appends. Writer failures surface through `recording.last_error` as before
  (REC-02).
- `stop()` order: detach the microphone, stop the worker (`mailbox.stop()`,
  drain, join), mark the inputs finished, then finalize with the unchanged
  `kRecorderFinalizeTimeoutMs` bound (`finalizeRecorderWriter` in
  `recorder_writer_factory.mm`, ctest-covered).
- Counters: `recording.video_frames` (appended), `dropped_frames` (mailbox
  replacements + CFR drops), `queued_frames` (pending in the mailbox); a
  rate-limited (5 s) `{"type":"meeting_recorder","event":"mailbox_replaced",
  "detail":"replaced=<n> total=<m> written=<k>"}` event flags an encoder that
  cannot keep up. `keyer.get.metrics.recorder_ms` reports the tick-side cost
  of the recorder tap on both platforms (macOS: the mailbox copy only;
  Windows additionally in the `keyer_budget_overrun` event as `recorder_ms`).

### Empty or failed recordings (`no_frames`, Nov 2026)

`finalizeRecorderWriter` handles two cases before the regular
`finishWriting`:

- The writer is already `Failed` when stop arrives (disk full, I/O error,
  encoder death — the worker reported it live via `recording.last_error`):
  `finishWriting` would only re-report it, and without movie fragments the
  sidecar has no `moov` atom and is unplayable, so the `.part` is removed and
  a `writer_failed` event with the full NSError (domain, code, underlying
  error) is logged.
- No video sample was ever committed (stop right after start, or the camera
  never delivered a program frame): the writer is cancelled, the `.part`
  removed, a `no_frames` event logged and `recording.last_error = "no_frames"`
  reported through the `recording.stop` result and the following status
  snapshots (the webapp renders `last_error` verbatim in the recording
  control). Measured with the production writer configuration: an empty
  writer otherwise *completes* with a 0-byte file, which the old code renamed
  to the final `.mp4` — the field finding was a 0-byte
  `broadify-….mp4.part` next to `finish_failed` events
  (`AVFoundationErrorDomain -11800`, underlying `-12737`). That failure code
  could NOT be reproduced in ctest with zero or few samples (video-only,
  audio-only, both, 1 frame): all finish with status Completed. A `.part` is
  still kept for `finish_failed` after frames were written and for
  `finalize_timeout`.

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
finalize step with the shared `kRecorderFinalizeTimeoutMs` (15 000 ms, defined
in `apps/bridge/native/helper-common/include/helper_common/recording_encode_policy.h`
and re-exported by `src/recorder/recorder_encode_policy.h`; the PGM recorder
waits on the same constant), which must stay below the RPC timeout;
`scripts/meeting-helper-release-contract.test.cjs` and
`scripts/pgm-helper-release-contract.test.cjs` parse the values and fail when
they drift.

The relay commands that stop a recording sit above that RPC: finalize 15 s <
`recording.stop` RPC 20 s < bridge-local SLA 30 s < relay timeout 35 s, for
`meeting_recording_stop` and `meeting_recording_toggle`
(`relay-command-policy.ts`, the same budget as `pgm_recording_stop`). Until
Nov 2026 `meeting_recording_stop` was declared in the fast class (12 s relay /
8 s local). The contract test covers the ordering of these numbers too.

A start has its own chain inside the same bridge-local SLA
(`meeting_recording_start`, and `meeting_recording_toggle` without an active
recording): encoder probe wait 5 s (only with a `codec`, only while the probe
has not settled) + `recording.status` 5 s (toggle) + `recording.start` RPC
15 s = 25 s < 30 s < 35 s. The contract test adds these up as well.

What the bridge policy does and does not do: the bridge never aborts a
command. It reads only the bridge-local SLA, and only to log
`command_sla_exceeded` when a command runs longer (`relay-client.ts`); the
relay timeout in the policy is the budget the bridge declares, not a timeout
it enforces. The timeouts that actually cut off a stop live in two other
repositories and have to follow this declaration:

The exact values of the whole chain, per command (ms). The bridge columns
are `relay-command-policy.ts`; the relay and web app columns are what their
tables need - a relay without an entry runs a command with 12 s execution, a
web app without one with 22 s:

| Command | Bridge-local SLA | Relay execution (= bridge policy) | Relay queue | Relay total (ack 5 s + queue + execution) | Web app client timeout |
| --- | --- | --- | --- | --- | --- |
| `meeting_recording_pick_path` | 125 000 | 130 000 | 3 000 | 138 000 | 138 000 |
| `meeting_recording_start` | 30 000 | 35 000 | 3 000 | 43 000 | 43 000 |
| `meeting_recording_stop` | 30 000 | 35 000 | 3 000 | 43 000 | 43 000 |
| `meeting_recording_toggle` | 30 000 | 35 000 | 3 000 | 43 000 | 43 000 |

`meeting_recording_pick_path` with a codec: the gate may wait up to 5 s for
the encoder probe before the save panel (120 s) opens, so the chain can reach
the bridge-local SLA of 125 s exactly. A panel left open to its limit after
such a wait can log `command_sla_exceeded`; the result is still delivered,
inside the relay's 130 s (guarded by the release contract test).

Relay service (`src/command-timeouts.ts`): all four are
`timeoutClass: "helper_start"`; `concurrencyKey` is `meeting.recording`
(`meeting.recording.dialog` for the save panel) and all invalidate
`meeting.recording`, as in the bridge policy. The commands stay `no_retry`: a
replayed toggle would stop what it just started. Web app
(`lib/bridge-command-timeouts.ts`): the client timeout is the relay total;
the web API route and the browser add their own margins on top.

Until both tables carry these entries, a finalize (or a save panel left open)
that outlasts the shorter default still shows as a timeout in the web app,
although the bridge completes the command and reports the result through the
recording status.

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
`RecorderAudioRebase` policy (meeting-internal in `recorder_encode_policy.h`,
unit-tested in `recorder_encode_policy_test`): a sample whose MF timestamp lies before the
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

## Recording format: codec and container (ADR-0010)

The codec is chosen per recording (`codec` in `meeting_recording_start` /
`meeting_recording_toggle`); size and frame rate always follow the running
program. The container and the audio codec follow from the codec:

| `codec` | Video | Container | Audio | Platforms |
| --- | --- | --- | --- | --- |
| `h264` (default) | H.264 High, `avc1` | `.mp4` | AAC 128 kbit/s | macOS, Windows |
| `hevc` | HEVC Main 8 bit, `hvc1` sample entry (opens in QuickTime and Apple players) | `.mp4` | AAC 128 kbit/s | macOS |
| `prores_422_lt` | ProRes 422 LT, 10 bit 4:2:2 | `.mov` | PCM 24 bit | macOS with ProRes hardware |
| `prores_422` | ProRes 422 | `.mov` | PCM 24 bit | macOS with ProRes hardware |
| `prores_422_hq` | ProRes 422 HQ | `.mov` | PCM 24 bit | macOS with ProRes hardware |

Audio is mono 48 kHz in every case. Windows writes H.264 only; it never gets
ProRes (there is no licensed encoder).

One table per side holds this mapping, and nothing else decides an extension:

- Bridge: `MEETING_RECORDING_CODEC_FORMATS` in
  `services/meeting/meeting-recording-codecs.ts`, read by the path guard of
  `MeetingRecordingStartSchema`, the default path builder, the save panel and
  the capability block.
- Helper: `kRecordingCodecFormats` in
  `native/meeting-helper/src/recorder/recording_codec.h`, read by
  `recording.start`, the writer factory and the recording status.
- `meeting-recording-codecs.test.ts` parses the native table and compares it
  with the bridge table row by row; `recording_codec_test` (ctest) pins the
  names on the native side.

### Data rates and file sizes

H.264 and HEVC are bitrate driven, ProRes is quality driven (the encoder takes
no bitrate; the values are Apple's published target rates, real files of a
calm picture are smaller). All values from `recorderVideoDataRateBps` in
`helper_common/recording_encode_policy.h`, video only; audio adds 0.06 GB/h
(AAC) or 0.5 GB/h (PCM).

| `codec` | 1080p30 | per hour | 1080p25 | per hour |
| --- | --- | --- | --- | --- |
| `h264` | 21.8 Mbit/s | 9.8 GB | 18.1 Mbit/s | 8.2 GB |
| `hevc` | 13.1 Mbit/s | 5.9 GB | 10.9 Mbit/s | 4.9 GB |
| `prores_422_lt` | 102 Mbit/s | 46 GB | 85 Mbit/s | 38 GB |
| `prores_422` | 147 Mbit/s | 66 GB | 122 Mbit/s | 55 GB |
| `prores_422_hq` | 220 Mbit/s | 99 GB | 183 Mbit/s | 83 GB |

At 50 and 60 fps (macOS, see
[50 and 60 fps](#50-and-60-fps-macos)):

| `codec` | 1080p60 | per hour | 1080p50 | per hour |
| --- | --- | --- | --- | --- |
| `h264` | 40 Mbit/s (cap) | 18 GB | 36.3 Mbit/s | 16.3 GB |
| `hevc` | 24 Mbit/s | 10.8 GB | 21.8 Mbit/s | 9.8 GB |
| `prores_422_lt` | 204 Mbit/s | 92 GB | 170 Mbit/s | 77 GB |
| `prores_422` | 294 Mbit/s | 132 GB | 245 Mbit/s | 110 GB |
| `prores_422_hq` | 440 Mbit/s | 198 GB | 367 Mbit/s | 165 GB |

- H.264: 0.35 bit/px, clamped to 2-40 Mbit/s (`recorderVideoBitrateBps`,
  shared with the PGM recording since ADR-0006 and unchanged by the codecs:
  `recording_encode_policy_test` pins that the H.264 rate by codec equals that
  function value for value). The 40 Mbit/s cap stays for 50/60 fps: 1080p50
  is under it (36.288 Mbit/s), 1080p60 is held to it instead of the policy
  value of 43.5 Mbit/s (0.32 instead of 0.35 bit/px). The linear policy
  over-allocates at high frame rates, where neighbouring frames differ less,
  and leaving the function alone keeps the PGM recording bit-identical.
- HEVC: 60 % of the H.264 bitrate (`kRecorderHevcBitrateFactor`). The HEVC
  verification tests measured about half the bitrate at equal quality, for
  offline encoders with B-frames and look-ahead; the recorder runs a
  real-time hardware encoder without frame reordering, so the policy keeps a
  margin instead of the full 50 %. It inherits the H.264 clamp (no higher
  resolution cap yet; that comes with 4K).
- ProRes: Apple's targets at 1920x1080 29.97 fps (102 / 147 / 220 Mbit/s),
  scaled with pixels and frame rate.

### Free disk space

A start is refused with `recording_disk_space_low` when the target volume has
less free space than **five minutes** of the codec's expected video data rate
(`recorderMinFreeDiskBytes`, `kRecorderMinFreeDiskMinutes`), instead of the
fixed 500 MB before. Five minutes is enough to notice the warning and finish
a take; the floor is a start check, not a forecast for the whole recording.

| `codec` | Required at 1080p30 | at 1080p25 | at 1080p60 | at 1080p50 |
| --- | --- | --- | --- | --- |
| `h264` | 0.82 GB | 0.68 GB | 1.5 GB | 1.4 GB |
| `hevc` | 0.49 GB | 0.41 GB | 0.9 GB | 0.82 GB |
| `prores_422_lt` | 3.8 GB | 3.2 GB | 7.7 GB | 6.4 GB |
| `prores_422` | 5.5 GB | 4.6 GB | 11 GB | 9.2 GB |
| `prores_422_hq` | 8.3 GB | 6.9 GB | 16.5 GB | 13.8 GB |

The refusal carries `data { required_bytes, free_bytes }`. The helper reports
the numbers in `recording.disk_space_low`; the bridge reads them from
`recording.status` after the refused start (best effort: if that read fails,
the `errorCode` comes without `data`). A disk that fills up during a
recording still surfaces through `recording.last_error` (REC-02).

### Hardware encoders only

A recording never runs on a software encoder (ADR-0010, the doctrine of
ADR-0002/0006/0009). On macOS two things hold that:

1. `makeRecorderWriter` asks the VideoToolbox encoder list (the same
   enumeration as `--probe-recording`) and refuses a codec without a hardware
   encoder with `meeting_recording_codec_unsupported` before a file exists.
2. Every video input carries
   `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` in
   `AVVideoEncoderSpecificationKey`. AVAssetWriter evaluates it in
   `startWriting`: measured on an M1 Pro (macOS 26), a writer whose
   specification additionally forbids hardware fails there with
   `AVFoundationErrorDomain -11834`, underlying `-12908`
   (`kVTCouldNotFindVideoEncoderErr`), for H.264, HEVC and all three ProRes
   flavours, instead of falling back. `recorderStartWritingError` maps that
   to the same token. `meeting_recorder_writer_test` repeats the measurement
   on every run.

This holds for the default as well: a start without `codec` (older web app,
REC key) is an H.264 recording and needs the hardware H.264 encoder. On a Mac
without one (in practice a virtual machine) it is refused with
`meeting_recording_codec_unsupported`, where the writer before ADR-0010 would
have encoded in software. The web app therefore maps that code for every
start, not only for one that named a codec.

Limit of that proof: AVAssetWriter does not say which encoder it used, so the
test shows that the requirement is enforced, not the encoder's name. On a
machine without a hardware encoder for a codec (hosted CI runners) the test
verifies the refusal and skips the cases that need a writer.

Windows keeps `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS` for its H.264 writer
and does not select its encoder explicitly yet (package A3).

## Encoding

H.264 and HEVC target a two-second GOP (`fps * 2`,
`recorderKeyframeInterval`) with frame reordering disabled; macOS requests
CABAC for H.264 and the Main profile for HEVC. ProRes is all-intra and takes
none of these. The rates are in
[Data rates and file sizes](#data-rates-and-file-sizes).

Video timestamps are written on a constant-frame-rate grid relative to the
writer session start. If the program frame source arrives late, the recorder
fills up to four missing frame slots with the latest frame. Gaps longer than
one second jump to the current grid position and emit one recorder event for
diagnostics. Encoder backpressure only commits frames that were actually
written, so unfilled slots are retried on the next program frame. Set
`BROADIFY_MEETING_RECORDER_CFR=0` to restore the legacy host-clock video PTS
path for diagnosis.

Both platform writers tag video as BT.709, for every codec. macOS sets
AVFoundation color properties on the video settings and pixel buffers; Windows
sets BT.709
matrix, transfer function, primaries and limited-range output media type while
keeping the RGB input range full-range.

The file has the size of the program canvas. A portrait program (engine
started with `height > width`, e.g. 1080x1920, see ADR-0007) is recorded as a
1080x1920 track without a rotation transform; the bitrate policy above applies
unchanged, since it only depends on the pixel count. Canvas and frame rate
cannot change while the engine runs, so a recording never switches format
mid-file: `meeting_engine_start` with another width, height or frame rate is
refused with `meeting_engine_restart_required` (the frame rate is part of that
comparison since ADR-0010), and the web app locks the program-format switch
while a recording is active.

### Recording capabilities (ADR-0010)

`get_status.capabilities.meeting.recording` tells the web app which codecs the
recorder can write on this machine: `codecs[]` with `codec`, `container`,
`max_height` and `max_fps`, plus `upload_copy`. A codec is listed only if both
hold:

1. the platform's recorder implements it (`MEETING_RECORDER_SUPPORTED_CODECS`
   in `services/meeting/meeting-capabilities.ts`, spelled out per platform:
   H.264, HEVC and ProRes 422 LT / 422 / HQ on macOS, `h264` on Windows, none
   elsewhere; a codec added to the contract is advertised nowhere until it is
   added to a platform there), and
2. the machine has a **hardware** encoder for it.

So a Mac without ProRes hardware reports `h264` and `hevc` only, and Windows
reports `h264` even with an HEVC encoder. `container` comes from the codec
table. `max_height` is that of `program_formats`; `max_fps` is the lower of
the platform's highest program frame rate and the codec's own cap in
`MEETING_RECORDER_CODEC_MAX_FPS` (macOS: 60 for every codec; Windows: 30 for
`h264`). That table is the one place to lower when a device measurement
shows that a codec does not hold a rate: the capability then reports the
lower `max_fps`, the web app marks the codec as not available for a faster
program, and the gate refuses it with `program_format_exceeded`.

`capabilities.meeting.recording_probe` says where the probe behind the list
stands, so the web app can tell "still checking" from "failed":

| `recording_probe` | `recording` | Meaning |
| --- | --- | --- |
| `pending` | absent | No result yet: not started, running, or a transient failure with attempts left. Later `get_status` calls trigger the retries, so the web app keeps polling. |
| `done` | present | The probe has a result (possibly an empty `codecs` list: no hardware encoder). A platform without a recorder reports `done` with an empty list without probing. |
| `failed` | absent | Settled without a result for this bridge run (`helper_missing`, `invalid_output`, `enumeration_failed`, or a transient failure after three attempts). Only a bridge restart probes again. |

The field is absent on bridges older than this package.

`meeting_recording_pick_path`, `meeting_recording_start` and
`meeting_recording_toggle` check a requested `codec` against this list and
the running program and refuse anything else - a name this bridge does not
know included - with `meeting_recording_codec_unsupported`, before the panel
opens or the helper is asked; see
[Every recording is what is configured](#every-recording-is-what-is-configured).

The hardware encoders come from the helper's probe mode,
`meeting-helper --probe-recording`
(`native/meeting-helper/src/recorder/recording_probe.*`). It prints one JSON
line and exits without starting the engine or opening a device:

```json
{"type":"recording_probe","backend":"videotoolbox","ok":true,"encoders":[{"codec":"h264","name":"Apple H.264 (HW)"},{"codec":"hevc","name":"Apple HEVC (HW)"}]}
```

- macOS reads the VideoToolbox encoder list and keeps the hardware-accelerated
  encoders for H.264, HEVC and ProRes 422 LT / 422 / HQ.
- Windows enumerates hardware encoder MFTs with `MFTEnumEx` for H.264 and
  HEVC, in the order the program-stream encoder ranks them
  (`live_stream/mf_encoder_policy.h`), each with its `vendor`. ProRes is never
  reported on Windows.
- `ok: false` means the enumeration itself failed (encoder list unknown); an
  empty `encoders` list with `ok: true` means the machine has no hardware
  encoder. Windows enumerates H.264 and HEVC independently: a codec whose
  enumeration fails is left out, and `ok` is false only when both fail.

`MeetingHelperManager.probeRecordingEncoders()` runs the probe on the first
`get_status` (5 s timeout) and keeps a result, or a definitive failure, for
the bridge run. A transient failure (timeout, launch error) is retried by
later `get_status` calls in the background, at most three runs in total; those
calls do not wait and answer `recording_probe: "pending"` without `recording`
until a run has succeeded. `awaitRecordingProbe()` is the variant for the
codec gate: it always waits for the attempt in flight, also a retry, and
starts one if none runs. `getRecordingProbeState()` is the state above.
While there is no result the `recording` field is omitted and each failed run
logs one warning with the reason; the recorder itself is unaffected. Software encoders are never listed: a codec
without hardware support is not offered rather than encoded on the CPU.

Quick probe after recording:

```bash
ffprobe -hide_banner -show_entries stream=codec_name,profile,codec_tag_string,bit_rate,avg_frame_rate,r_frame_rate,color_space,color_transfer,color_primaries,bits_per_sample:format_tags=major_brand -of default=noprint_wrappers=1 recording.mov
```

Expected: `h264` High `avc1` / `hevc` Main `hvc1` with `major_brand=mp42`;
`prores` LT / Standard / HQ (`apcs` / `apcn` / `apch`, `yuv422p10le`) with
`pcm_s24le` audio and `major_brand=qt`. `meeting_recorder_writer_test` writes
a 1080p25 clip per codec through the production writer and worker and reads
these properties back; `BROADIFY_RECORDER_TEST_KEEP=1` keeps the clips for a
manual look.

## 50 and 60 fps (macOS)

`capabilities.meeting.program_formats.fps` is `[25, 30, 50, 60]` on macOS and
`[25, 30]` everywhere else (`MEETING_PROGRAM_FORMAT_LIMITS`; Windows stays at
25/30 until a device measurement). The recording always has the program's
frame rate: at 50/60 fps the recorder gets every program frame, the CFR
clock, the two-second keyframe interval (`2 x fps`) and the mailbox capacity
follow the rate, and the data rates are those in
[Data rates and file sizes](#data-rates-and-file-sizes). What else changes
above 30 fps:

- **Virtual camera and previews get every second frame** (`outputDivisor` in
  `native/meeting-helper/src/common/output_rate.h`: 60 -> 30, 50 -> 25). The
  macOS camera extension emits a fixed 30 Hz and Teams/Zoom cap at 30 anyway.
  Everything fed by `PreviewFrameStore` is decimated at the one publish site
  in the program loop (`PreviewPublishGate`, `frame_pipeline_gating.{h,cpp}`):
  the virtual camera's raw stream, the WebRTC program stream (its encoder is
  configured with the halved rate and stays on the existing bitrate rung) and
  the MJPEG preview. 50 -> 25 rather than 50 -> 30: every second frame keeps
  even 40 ms steps - the cadence a 25 fps program already delivers to the
  30 Hz extension - where 50 -> 30 would need an uneven 20/40 ms pick. It also
  halves the loopback load (1080p BGRA is 8.3 MB per frame). The gate is time
  based (a publish at the earliest 1.5 frame intervals after the last one),
  not tick parity, because with a 30 fps camera in a 60 fps program every
  render can fall on an odd tick; a frame that was held back stays pending,
  so the last picture is still published when the program goes static. Up to
  30 fps the gate publishes exactly as before.
- **A camera that cannot deliver the rate keeps its resolution.**
  `selectCaptureFormat` (`capture_format_selection.{h,cpp}`) picks, in this
  order: the requested rate at a size not below the requested one; above
  30 fps, **half the rate** at such a size (60 -> 30, 50 -> 25, match
  `half_rate`); the requested rate at a smaller size; the nearest rate,
  above 30 fps first among the formats not below the requested size. A
  webcam with 1080p30 and 720p60 therefore stays at 1080p30 in a 60 fps
  program and each camera frame is shown twice (a clean 2:1), while graphics,
  screen and media run at the full rate. In a 50 fps program the same webcam
  has no 25 fps mode; it also stays at 1080p30 (match `nearest`), and its
  frames are repeated unevenly (30 in a 50 fps grid). The program and the recording keep
  the configured rate; nothing is refused. The helper reports what the
  program camera delivers as `engine.camera_format` (see
  `meeting-status-contract.md`), and the web app shows a hint when that rate
  is below the program's.
- **Graphics planes** run at the program rate; the pre-warm at engine start
  uses the requested frame rate (it used a fixed 30 before, which configured
  the planes twice for every other rate).
- **Keyer:** 50 and 60 fps are not available together with keying, see
  [Keying runs at up to 30 fps](#keying-runs-at-up-to-30-fps). No ladder or
  budget change. The dropout holds of `stabilizeFusedMask` count keyer runs
  and are doubled when the keyer runs above 30 times per second
  (`fusedKeyerHoldScale`), so they stay 1.5 s / 3 s; with a half-rate camera
  they are unchanged.

### Keying runs at up to 30 fps

Device test on an M1 Pro (2026-11-22): one run of the fused CoreML MODNet
keyer takes about 22 ms. A 60 fps program has 16.7 ms per tick, so with the
keyer on it reached about 31 ticks per second (27 to 31 across the runs) and
the recording, written on a 60 fps grid, contained duplicated frames. Without
the keyer the same program held 59.97 fps.

Owner's decision (ADR-0010, addendum "Keying nur bis 30 fps"): 50 and 60 fps
are not available together with keying.

- **One limit:** `capabilities.meeting.program_formats.keyer_max_fps`, `30`
  on every platform (`BASE_MEETING_PROGRAM_FORMAT_LIMITS` in
  `services/meeting/meeting-capabilities.ts`, the one place to raise when a
  keyer holds more). The web app reads the limit from there.
- **What "keying active" is:** `keyer.settings.enabled` in the helper, set
  only by `meeting_keyer_configure` (`enabled`). Model and background fields
  do not turn keying on, and a freshly started helper has it off.
- **The gate** (`gateKeyerEnable` in `meeting-command-handler.ts`, deciding
  with `findKeyerFpsExcess`): `meeting_keyer_configure` with `enabled: true`
  while the running program is faster than `keyer_max_fps` is refused with
  `errorCode: "meeting_keyer_fps_unsupported"` and
  `data { program_fps, keyer_max_fps }`, before the helper is asked: nothing
  of the patch is applied, also not its background. Turning keying off and
  patches without `enabled` pass at every rate, so passthrough at 50/60 fps
  stays possible.
- **`meeting_engine_start` needs no gate.** A start with another frame rate
  than the running engine is refused with `meeting_engine_restart_required`
  anyway. A start that spawns a helper begins with keying off, and the
  bridge replays no keyer config into it (`meeting_engine_stop` drops the
  noted config); keying comes back only through `meeting_keyer_configure`,
  i.e. through the gate.
- **Crash recovery** is the only place the bridge re-applies a keyer config
  itself (`MeetingHelperManager.restoreRuntimeConfig`), into an engine with
  the frame rate it had. The replay is held to the same limit
  (`resolveKeyerRestoreConfig`): a config noted on a slower engine - a user
  start at 50/60 fps during a recovery, then another crash - is replayed
  with keying off and a warning in the log.
- **Lowering the rate is the web app's job.** It needs an engine restart,
  which ends a recording and drops camera and virtual camera, so the bridge
  never does it. When the user turns keying on at 50/60 fps the web app
  first switches the program to half the rate (60 -> 30, 50 -> 25) through
  its program-format switch, then enables keying and tells the user; during
  a recording it does not enable keying. Nothing raises the rate again when
  keying is turned off.
- **Stream Deck limit:** a key bound to `meeting_keyer_configure` with
  `enabled: true` runs in the bridge without the web app. At 50/60 fps it is
  refused by the gate: the key flashes red and `streamdeck_error` carries
  `error_code: "meeting_keyer_fps_unsupported"`, which an open web app
  translates. There is no automatic restart from the bridge; lower the frame
  rate on the recording-format page (or turn keying on in the web app) first.

Measured in the same device test: recordings in every codec at 25, 30, 50
and 60 fps have the configured frame rate and codec. Not measured: the
encoders under full load (the picture was almost black, so the data rates
say nothing; a codec that does not hold a rate is lowered in
`MEETING_RECORDER_CODEC_MAX_FPS`), a real 50/60 fps camera, the virtual
camera in Teams/Zoom, and screen capture without a camera at 60 fps (the
loop holds an absolute frame grid only with a camera or with no source; with
screen capture alone it wakes on every new screen frame, so its ticks follow
the screen source).

### Audio track starts about 0.1 s after the video (macOS)

Every file of the device test shows the audio stream starting 90 to 100 ms
after the video (`ffprobe -show_entries stream=codec_type,start_time`: video
`0.000000`, audio `0.090000` to `0.100167`, AAC and PCM alike). This is a
microphone that starts late, placed at the right time - not a shifted track:

- The writer session starts at a host-clock time (`startSessionAtSourceTime`)
  taken **before** the microphone session is started. `startRunning` blocks
  until the device runs, and the capture delegate appends nothing until the
  recorder is published as active after it. The first buffer that reaches
  the writer was captured roughly 0.1 s after the session start.
- Audio buffers are appended with their own capture timestamps, unchanged.
  The writer places them at `timestamp - session start` and represents the
  missing beginning as a gap at the start of the track, which ffprobe shows
  as `start_time`. Nothing is shifted to fill it.
- Video frames are placed on the CFR grid by the host-clock time of their
  tick relative to the same session start. The grid is filled from index 0:
  the first program frame is repeated for the frames before it
  (`RecorderFrameClock::plan`), which is why the video track starts at 0.
- The files agree: for the four PCM recordings (no encoder delay to account
  for), audio start plus audio duration ends within -17 to +25 ms of the end
  of the video track (+1.7, +6.7, -17.4, +24.7 ms). An audio track shifted
  by 95 ms would end about 95 ms after the video.

So no behaviour was changed. What this does not cover: the latency of the
picture itself (camera, keyer, compositor) is not compensated in the audio;
measuring lip sync needs a clap in front of camera and microphone.


## Upload to the platform (ADR-0011)

A finished H.264 or HEVC recording is uploaded to the platform's Post
Production storage in the background, after the stop. Code:
`apps/bridge/src/services/postpro/`. Decision and security model:
[ADR-0011](../architecture/adr/0011-aufnahme-upload-zur-plattform.md). Relay
contract (capability, command, event):
[meeting-status-contract.md](./meeting-status-contract.md), section
Aufnahme-Upload.

### When a recording is uploaded

All of these must hold, otherwise the recording stays where it is and nothing
is sent:

- The bridge can upload (`capabilities.meeting.recording_upload`): it has a
  platform address and a bridge id (relay set up).
- The web app pushed `meeting_recording_upload_configure { enabled: true }`
  (the user's switch "Upload recordings automatically"; off by default, stored
  in `<userData>/recording-upload/settings.json`). The value at the moment of
  the stop counts.
- The platform accepts the upload at `begin` (organisation has the Post
  Production mode, the user consented, monthly limits). It is the authority;
  the pushed value is only a hint that keeps bridges without consent silent.
- The recording finished cleanly: `recording.last_error` is empty, the file
  exists under its final name with a size above zero and has no `.part`
  sibling.
- The codec is `h264` or `hevc`. **A ProRes master is never uploaded**: it
  stays local and the web app is told why (`last_skipped.reason:
  "prores_master_local"`). An upload copy of a ProRes recording is a later
  step; `capabilities.meeting.recording.upload_copy` stays `false` until then.

Every kind of stop is covered, because the trigger is the recorder state in
the published meeting status and not a command
(`recording-upload-trigger.ts`, called from
`MeetingHelperManager.publishStatus`): web button, Stream Deck key, engine
stop, bridge shutdown. A record of the running recording is written at its
start, so a bridge crash or a shutdown before the stop was seen is settled at
the next start by the same rule: a crash leaves the `.part` file and nothing
is uploaded (`file_incomplete`); a recording finalized on quit is uploaded.
A status that cannot say what the recorder is doing (helper not answering,
`recording.status` timed out while a stop finalizes) is ignored instead of
being read as a stop.

| `last_skipped.reason` | Meaning |
| --- | --- |
| `prores_master_local` | ProRes master, stays local |
| `recording_failed` | the recorder reported an error (`last_error`) |
| `file_incomplete` | a `.part` file is left (crash, finalize failure) |
| `file_missing` | no file under the final name, or it is empty |

### What is sent, and where

- To the platform (web app, bridge-signed like the session-log routes,
  `x-postpro-bridge-assertion`): the file's basename, size, codec, container,
  program size and frame rate, duration, start time, and at the end the
  sha256. Routes `POST /api/postpro/bridge/recordings/{begin,complete,abort}`.
- To the platform's storage (Supabase Storage, resumable upload): the file's
  bytes, to the path and with the short-lived signed token that `begin`
  returned. The bridge never chooses the path.
- The platform address comes from the bridge's configuration only: the
  release-managed `PRODUCTION_STUDIO_CONTROL_WEBAPP_URL` of the channel (must
  be a public https URL on port 443), or the operator override
  `POSTPRO_API_URL` / `--postpro-api-url` for development. No relay command
  can set it. The storage endpoint returned by `begin` must be the signed
  resumable endpoint (`/storage/v1/upload/resumable/sign`) on a public https
  host, and every upload URL must stay on its origin.

**The local file is only read.** It is never modified, moved or deleted, and
nothing is written next to it.

### How it is uploaded

One task at a time, from a persisted queue
(`<userData>/recording-upload/queue.json`):

`queued` -> begin -> `hashing` (sha256 of the whole file, streamed) ->
`uploading` -> `completing` (the file must still have the size and
modification time it was enqueued with) -> `done`.

- **Streaming:** the file is never loaded as a whole. The upload reads it in
  slices of at most 64 KiB, the hash in blocks of 1 MiB; neither holds more
  than one of them in memory.
- **Resumable (tus 1.0, own minimal client `tus-upload-client.ts`):** the
  upload is created with `POST`, sent with `PATCH` in chunks of the size the
  platform names (6 MiB, which Supabase requires for every chunk but the
  last), and after any interruption continued at the offset the server
  reports for `HEAD`. A bridge restart does the same: begin again (fresh
  token), `HEAD`, continue.
- **Token lifetime:** the signed upload token is valid for a limited time (2
  hours, counted from the `begin` that issued it, so hashing time counts). It
  stays in use until 10 minutes before its end or until the storage refuses
  it, and is then re-issued through `begin`. If the storage no longer knows
  the upload URL, or accepts no token on it any more, the same file is
  uploaded again from byte 0, at most three times per task
  (`upload_restarts_exhausted` after that). The token is kept in memory only.
- **Last chunk:** the storage creates the object with the last chunk. Before
  sending it the bridge asks the platform once more (`begin`, unless it did
  so within the last minute); a recording the user deleted meanwhile ends as
  `cancelled` and its object is not created. A deletion during the last chunk
  itself is not caught by the bridge.
- **Retries:** failures are retried with backoff (30 s doubling up to 30 min,
  20 % jitter). A task ends as `failed`
  - after 40 consecutive attempts without a byte of progress that the
    platform or the storage answered with an error
    (`upload_retries_exhausted`). Attempts that got no answer at all (no
    network, DNS, timeout) do not count toward the 40;
  - 7 days after it was enqueued (`upload_expired`), which is the only bound
    for a bridge that stays offline;
  - when the file changed (`file_changed`) or is gone from a folder that
    still exists (`file_missing`). A file that cannot be reached right now
    (volume not mounted, share down, permission or I/O error) is not given
    up: the task waits with `file_unavailable` and tries again, up to the 7
    days;
  - on a permanent answer of the platform, or when the storage refuses to
    create the upload with 400, 413 or 415 (`storage_http_<status>`, for
    example a project file size limit below the recording's size);
  - when it is larger than the platform takes (50 GiB,
    `recording_too_large`, decided without a request).
  A task that ends as `failed`, or as `cancelled` while the platform still
  has an open row for it, tells the platform (`abort`, best effort).
- **Queue file:** writes run one after the other. An existing queue file
  that cannot be read or parsed is discarded with a warning
  (`Discarding the persisted upload queue (...)`), never silently.
- **Terminal states** stay visible for 7 days (at most 20), then the record
  is dropped. There is no manual retry from the web app in this stage; the
  file is still on disk.

Reaction to the platform's error codes (`recording-upload-platform.ts`):

| Code | Reaction |
| --- | --- |
| `upload_not_enabled`, `bridge_not_linked` | task `cancelled`; the local hint is switched off; `abort` for a known row |
| `recording_deleted` | task `cancelled` |
| `recording_not_uploading` (at complete) | the platform closed the row (stalled upload): `begin` reopens it and `complete` is repeated once without re-sending bytes; a second refusal is `failed` |
| `limit_minutes`, `recording_too_large`, `recording_not_found`, any other 400 (`invalid_request`) | task `failed`, no retry |
| `size_mismatch`, `object_missing` (at complete) | upload once more from byte 0, then `failed` |
| 401, 5xx, network errors, anything unknown | retry with backoff |

While a task waits for its next attempt, `error_code` names the last failure
by kind only: `network_error`, `platform_http_<status>`,
`storage_http_<status>`, `platform_response_invalid`, `file_unavailable`.

The file name sent to the platform is the basename, cut to 200 characters
with the extension kept.

Switching the upload off stops new enqueues. Tasks already in the queue keep
running on the bridge, but the platform is the authority at every `begin` (a
new attempt, a token refresh, an upload restart, the question before the last
chunk). If it answers `upload_not_enabled`, the running task ends as
`cancelled` and the bridge closes the platform's row with `abort`. Whether a
running upload may finish after the switch-off is therefore the platform's
decision; the bridge needs no change for either answer.

Status events are published only while the relay is connected. An upload
that runs without the relay stays silent; after the reconnect the web app's
configure command returns the current snapshot.

### Bandwidth: `BRIDGE_RECORDING_UPLOAD_MAX_KBPS`

The upload starts right after the stop and shares the line with a call that
may still be running. It is not paused during a call. The only control is the
environment variable `BRIDGE_RECORDING_UPLOAD_MAX_KBPS` (`userData/.env` or
the shell, read at bridge start): a positive integer in kbit/s caps the upload
rate (for example `8000` for 8 Mbit/s); unset, empty or not a positive
integer means unlimited. The cap paces the bytes of each chunk in slices of
at most 64 KiB. There is no setting in the web app.

### What is logged

Under the prefix `[RecordingUpload]`, at `info` (queued, uploaded, not
uploaded with its reason, switch on/off) and `warn` (failed attempt, terminal
failure): the file's **basename**, its size, the state and an error code.
Never the full path, the platform or storage URL, the upload token, a
response body or the sha256. The status event carries the same restriction.

### Not verified yet

- No upload against the real platform or storage was run from the bridge in
  this package; the client is tested against a local tus server (interrupt,
  resume, token expiry, offset conflict, lost upload URL). The storage's
  behaviour for a re-issued token on an existing upload and the lifetime of an
  upload URL are assumptions. If either turns out against the bridge, an
  upload shorter than the token's lifetime (2 hours) is unaffected, and a
  longer one restarts from byte 0 up to three times and then ends as
  `failed upload_restarts_exhausted`: recordings that need more than 2 hours
  to upload would then not arrive. This must be checked against the real
  storage in the first device test.
- Whether the release candidate's web app address is reachable for the
  bridge's unauthenticated, bridge-signed requests (a deployment protection
  in front of it would answer 401 to every `begin`, which is retried and ends
  as `upload_retries_exhausted`).
- Windows: the code has no platform-specific path (it uses `node:fs` and
  `node:https` only), but it has not run on a Windows device.
- Hashing and uploading a multi-gigabyte file run inside the bridge process.
  Their effect on a call that starts right after a long recording has not
  been measured.

## WebApp

`MeetingRecordingControl` (meeting builder, below the preview panel) drives the
flow through `stores/meeting-engine-store.ts`: pick path -> start -> poll
`meeting_recording_status` every second while active -> stop. Client timeouts
live in `lib/bridge-command-timeouts.ts`; the rule is that each is above the
relay timeout of its command in the bridge policy (130 s for pick_path, 35 s
for start, stop and toggle), see
[Finalize timeout](#finalize-timeout-both-platforms) for stop and toggle.

## Stream Deck

`meeting_recording_toggle` (one-key start/stop with a default recording path,
no save dialog) exists for the Stream Deck REC key and shares the same helper
recorder. The file goes to the shared default recordings folder described
above (`~/Movies/Broadify` on macOS, `~/Videos/Broadify` on Windows) as
`Broadify-Meeting-<stamp>.<ext>` — the same place and naming as the save-panel
fallback.

The key records the codec configured on the web app's recording-format page:
the web app writes it as `codec` into the payload of every
`meeting_recording_toggle` binding and pushes the mapping
(`streamdeck_configure`); the bridge persists the mapping
(`.bridge-data/streamdeck/mapping.json`) and the Stream Deck manager hands the
binding's payload to the command on every press, without the web app. A
binding without `codec` records H.264 (H.264 configured, or a web app older
than the stamping). The codec is checked like every start; a refused press
flashes the key red and publishes `streamdeck_error` with
`error_code: "meeting_recording_codec_unsupported"`
(see [Every recording is what is configured](#every-recording-is-what-is-configured)).
The payload is read only when the toggle starts a recording: on an active
recording the toggle stops it whatever the binding carries. A key that turns
keying on is refused at 50/60 fps the same way, see
[Keying runs at up to 30 fps](#keying-runs-at-up-to-30-fps). Before Oct 2026 the toggle wrote `~/Videos/Broadify Recordings/
meeting-<iso-stamp>.mp4` on every platform, i.e. a different folder than the
other triggers and a Windows-style path on macOS.
