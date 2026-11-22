# Task: Meeting recording codecs and containers, macOS (package A2)

## Raw request
Package A2 of the approved plan "Meeting-Aufnahmeformat einstellbar + Post Production in der Cloud" (Vorhaben A):
the meeting recorder writes a selectable codec. Scope: one request struct for the native recorder, the macOS writer
(H.264, HEVC, ProRes 422 LT/422/HQ, hardware only), one codec -> container table per side, the capability list per
platform with a gate on start/toggle, bitrate policy per codec, a free-disk floor that follows the data rate, the
stop timeouts, docs and ADR-0010. Out of scope: an upload copy, HEVC on Windows (A3), 4K (A4), the web app (A5).
Local commits only; nothing is pushed, no PR, no bridge/helper instance is started.

## Context
- Customer / project: broadify bridge, meeting mode
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-recording-codecs,
  feature/meeting-recording-codecs
- Base branch: feature/meeting-recording-capabilities (package A1, unmerged, on top of dev dfc9e160)
- Decisions taken by the owner: 25 fps is offered now; hardware encoders only, so ProRes only where the probe
  reports ProRes hardware; Windows gets no ProRes.

## Plan
1. Native: `RecordingRequest` replaces the five parameters of `MeetingRecorder::start` (macOS, Windows, stub);
   `RecordingCodec` moves to helper-common, `recorder/recording_codec.h` holds the codec -> container/audio table;
   `recording.start` parses `codec` (absent = h264); the status reports `codec`, `container`, `disk_space_low`.
2. macOS writer: codec, file type, profile and audio from the request; hardware required through the encoder
   specification plus a VideoToolbox pre-check; CFR clock, BT.709 and `.part` finalize untouched.
3. Bridge: `meeting-recording-codecs.ts` as the single table, read by the path guard, the default path, the save
   panel, the schemas (`codec` optional on start, toggle, pick_path) and the capability block.
4. `MEETING_RECORDER_SUPPORTED_CODECS` per platform; start/toggle gated with `meeting_recording_codec_unsupported`.
5. `recording_encode_policy.h`: data rate per codec, H.264 unchanged; free-disk floor of five minutes with
   `recording_disk_space_low` and the required bytes.
6. `meeting_recording_stop`: relay 35 s / local 30 s, contract test extended.
7. Docs: meeting-recording.md, meeting-status-contract.md, relay-protocol.md, ADR-0010 (addendum).

## Acceptance criteria
1. Each codec written by the production writer and worker reads back as the right container brand, sample entry,
   profile, BT.709 tags and audio format (ctest `meeting_recorder_writer_test`, plus ffprobe by hand).
2. A codec without a hardware encoder is refused with the codec token, and a writer that cannot get hardware fails
   in `startWriting` instead of falling back (ctest).
3. The H.264 rate by codec equals `recorderVideoBitrateBps` value for value, so the PGM recording is unchanged
   (ctest `recording_encode_policy_test`).
4. The bridge table and the native table agree row by row (jest reads `recording_codec.h`).
5. A start without `codec` is byte-for-byte the RPC it was; a start with an unadvertised codec never reaches the
   helper (jest).
6. `recording_disk_space_low` carries `required_bytes` / `free_bytes` (jest, ctest for the status JSON).
7. finalize 15 s < `recording.stop` RPC 20 s < local SLA 30 s < relay 35 s (release contract test, shown red with
   the old 12 s / 8 s).

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
  - A Stream Deck REC key sends no payload and therefore always records H.264, whatever the web app has selected.
  - On a machine without a hardware H.264 encoder (hosted CI runner) `meeting_recorder_writer_test` verifies the
    refusals and skips the cases that need a writer.
  - `meeting_recording_pick_path` and `meeting_recording_toggle` now validate their payload with a schema; the old
    fields stay lenient, an unknown `codec` is an invalid payload.
- Handoff to human (if any):
  - Windows recorder (`meeting_recorder_mediafoundation.cpp`) is unverified until Windows CI / device.
  - No recording from the running engine with a real microphone was made; the bridge on this machine was not started.
  - Web app: client timeout for `meeting_recording_stop`, mapping of the two new error codes, `codec` in the payloads.

## Verification
- [x] Tests pass (jest 238 suites / 2899 tests; ctest recorder_encode_policy_test, recording_encode_policy_test,
      recording_codec_test, recording_probe_test, control_server_test, meeting_recorder_writer_test; release contract
      tests 138)
- [x] Lint / type-check pass (`npm run lint`, `tsc -p apps/bridge/tsconfig.build.json`, `npm run build:protocol`)
- [ ] Browser-verified (if UI-affecting) - not applicable, no UI in this package
- [x] Behaviour change shown red before green (stop-timeout contract test fails with the old fast class)
