# Task: Meeting recording "what is configured", 50/60 fps on macOS, probe state (bridge package)

## Raw request
Owner decisions (2026-11-22): 1. "Recording soll das sein, was eingestellt ist." 2. Conference is ignored for now;
50 and/or 60 fps for the Meeting mode instead. Bridge side of the cross-repo contract G1-G4:
- G1: every recording trigger uses the configured codec; if it cannot be recorded the start is refused, never
  recorded as something else.
- G2: 50 and 60 fps selectable for the Meeting program (and so the recording) on macOS; Windows keeps 25/30.
- G3: the bridge reports the encoder-probe state (`pending` / `done` / `failed`).
- G4: the bridge's timeout declarations stay; the contract test also guards the start chain.
Local commits only; nothing is pushed, no PR, no bridge/helper instance is started.

## Context
- Customer / project: broadify bridge, meeting mode
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-recording-50-60,
  feature/meeting-recording-50-60
- Base branch: feature/meeting-recording-codecs (packages A1 + A2, unmerged, on top of dev dfc9e160)
- Other packages of the same contract (not in this worktree): web app (deck stamp, format page, hints, timeout
  table), relay (`src/command-timeouts.ts` entries for the four `meeting_recording_*` commands).

## Plan
1. G3: `MeetingHelperManager.getRecordingProbeState()`, `capabilities.meeting.recording_probe` in `get_status` and
   the local video route, `MeetingCapabilitiesT`.
2. G1: `gateRequestedRecordingCodec` async for pick_path / start / toggle: waits for a probe attempt in flight
   (`awaitRecordingProbe`), refuses unless the codec is advertised and covers the running program; refusal carries
   `data { codec, reason }`. `streamdeck_error` carries `error_code`.
3. G2 capabilities: program limits per platform (macOS 25/30/50/60), `MEETING_RECORDER_CODEC_MAX_FPS`, `max_fps` per
   codec, engine start gate on the capability block, graphics pre-warm at the requested frame rate.
4. G2 native: `common/output_rate.h` (`outputDivisor`), `PreviewPublishGate` at the one publish site, program stream
   and raw stream header at the halved rate, half-rate tier in `selectCaptureFormat`, `camera_format` in `state.get`,
   keyer dropout holds scaled, recorder mailbox capacity by frame rate, policy tests for 50/60 fps.
5. G4: release contract test adds up probe + status + start against the bridge-local SLA for start and toggle.
6. Docs: meeting-recording.md, meeting-status-contract.md, relay-protocol.md, meeting-field-checklist.md, ADR-0010
   (second addendum).

## Acceptance criteria
1. `get_status` and `/video/status` report `recording_probe`; `recording` is present exactly when it is `done`
   (jest).
2. A request with a codec that is not advertised, does not cover the running program, or cannot be checked is
   refused for all three commands with `meeting_recording_codec_unsupported` and the matching `reason`, before the
   panel opens or the helper is asked; a request without codec is not gated (jest).
3. A key press before any `get_status` is decided on a probe result, not on "unknown" (jest: `awaitRecordingProbe`
   starts and joins attempts).
4. macOS advertises 25/30/50/60 fps and `max_fps` 60 per codec; Windows and others 25/30 (jest, platform explicit).
5. Above 30 fps `PreviewFrameStore` gets every second program frame, also when renders fall on odd ticks, and the
   last rendered frame when the picture goes static; up to 30 fps nothing changes (ctest, shown red without the
   decimation).
6. A camera with 1080p30 + 720p60 stays at 1080p30 for a 60 fps program (`half_rate`); up to 30 fps the selection is
   unchanged (ctest).
7. `state.get` reports `camera_format` or null (ctest).
8. H.264 1080p50 = 36 288 000 bit/s, 1080p60 = 40 000 000 bit/s, ProRes 422 HQ 1080p60 needs 16.5 GB free;
   `recording_encode_policy.h` logic unchanged (ctest).
9. probe 5 s + status 5 s + start 15 s < bridge-local 30 s < relay 35 s for start and toggle (release contract test,
   shown red with a 15 s probe timeout).

## Follow-up after the device test (2026-11-22): keying runs at up to 30 fps
Owner's decision: 50 and 60 fps are not available together with keying (keyer about 22 ms per run on the M1 Pro, a
60 fps program reaches about 31 ticks/s with it, 59.97 without). Bridge side:
- `capabilities.meeting.program_formats.keyer_max_fps` (30), the one source of the limit.
- `meeting_keyer_configure` with `enabled: true` on a faster program is refused with
  `meeting_keyer_fps_unsupported` and `data { program_fps, keyer_max_fps }` before the helper is asked (jest).
- `meeting_engine_start` needs no gate (a spawned helper has keying off, the bridge replays nothing into it); the
  crash-recovery replay is held to the limit (jest). A Stream Deck key is refused by the same gate.
- Recorder: a start refused with `already_recording` no longer overwrites `recording.last_error`
  (`claimRecordingStart`, ctest `recorder_start_claim_test`, shown red with the old write).
- Analysed, unchanged: the audio track starting 90-100 ms after the video is a late-starting microphone placed at
  the right time (meeting-recording.md). `audio_samples_*` are Windows-only; the contract says so.
- Not compiled here: `meeting_recorder_mediafoundation.cpp` (Windows) with the shared claim and the new return type.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
  - Keyer holds: scaled by the keyer's run rate (camera frames the program takes), not by the program rate alone,
    so a half-rate camera keeps today's hold lengths and 25/30 fps stay bit-identical.
  - `camera_format` is read from the camera backend, not stored in `MeetingState`; Windows reports null.
  - Review round 1: the nearest tier of `selectCaptureFormat` prefers formats not below the requested size above
    30 fps (1080p30 + 720p60 webcam at 50 fps stays 1080p30). This goes beyond the contract's tier list; owner to
    confirm. The release contract test also adds up probe + save panel for `meeting_recording_pick_path`.
  - The raw stream header (`X-Broadify-Frame-Fps`) carries the delivered rate (30 / 25 above 30 fps); the macOS
    extension does not read it.
- Handoff to human (if any):
  - Device test: keyer at 60 fps, one recording per codec at 1080p50 and 1080p60 from the running engine, program
    loop grid under load, virtual camera in Teams/Zoom, a half-rate camera, virtual-camera frame rate while the
    keyer runs at 60 fps (the preview gate halves the rate the program reaches), screen capture without a camera at
    60 fps (the loop then follows the screen source, not the absolute grid), a 1080p30 + 720p60 webcam at 50 fps.
  - Windows: `frame_pipeline.cpp` changes inside `_WIN32` blocks (two call sites get `holdScale = 1`) are not
    compiled here.
  - Relay and web app packages must land with this one (timeout tables, deck stamp, `recording_probe`).

## Verification
- [x] Tests pass (jest 238 suites / 2931 tests; release contract tests 138; ctest capture_format_selection_test,
      frame_pipeline_gating_test, recorder_frame_mailbox_test, control_server_test, program_stream_rpc_test,
      meeting_recorder_writer_test, options_test, recording_encode_policy_test)
- [x] Lint / type-check pass (`npm run lint`, `tsc -p apps/bridge/tsconfig.build.json`, `npm run build:protocol`,
      `tsc --project src/electron/tsconfig.json`)
- [x] Native: full meeting-helper build (macOS arm64, Release, MODNet off, -j2)
- [ ] Browser-verified (if UI-affecting) - not applicable, no UI in this package
- [x] Behaviour change shown red before green (preview gate without decimation; start chain with a 15 s probe)
