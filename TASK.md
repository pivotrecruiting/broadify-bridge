# Task: Meeting recording/program capabilities and contract (package A1)

## Raw request
Package A1 of the approved plan "Meeting-Aufnahmeformat einstellbar + Post Production in der Cloud" (Vorhaben A):
the bridge reports what the machine can really do, instead of the web app guessing by platform. Scope: shared
protocol types, a hardware-encoder probe in the meeting helper (macOS + Windows), the capability mapping in the
bridge, frame rate as part of the restart decision, a format gate on `meeting_engine_start`, docs and ADR-0010.
Out of scope: the recorder itself (codecs/containers are package A2), the web app, the virtual camera.
Local commits only; nothing is pushed, no PR, no bridge/helper instance is started.

## Context
- Customer / project: broadify bridge, meeting mode
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/meeting-recording-capabilities,
  feature/meeting-recording-capabilities
- Base branch: dev (dfc9e160, v0.27.3-rc.24)

## Plan
1. `packages/protocol`: `MeetingRecordingCodecT`, `MeetingRecordingContainerT`, `MeetingRecordingFormatT`;
   `MeetingCapabilitiesT` gets optional `program_formats` and `recording`.
2. Helper: `--probe-recording` prints one `recording_probe` JSON line (hardware encoders only) and exits.
   Platform-neutral result + JSON in `recorder/recording_probe.{h,cpp}` (ctest); VideoToolbox, Media Foundation
   and stub behind the existing per-platform split.
3. Bridge: `meeting-recording-probe.ts` (spawn with timeout, zod); `MeetingHelperManager.probeRecordingEncoders()`
   runs it once per bridge run, never from `start()`; `getMeetingCapabilities` maps it. Advertised codecs =
   `MEETING_RECORDER_SUPPORTED_CODECS` (h264/mp4 today) intersected with the probe.
4. `isSameProgramGeometry` -> `isSameProgramFormat` (width, height, fps); `meeting_engine_start` is gated against
   `MEETING_PROGRAM_FORMAT_LIMITS` with `meeting_program_format_unsupported`.
5. Docs: meeting-status-contract.md, meeting-recording.md, relay-protocol.md, meeting-helper-dev-setup.md,
   ADR-0010 (cross-reference in ADR-0007 and the index).

## Acceptance criteria
1. `get_status.capabilities.meeting` carries `program_formats` always and `recording` when the probe succeeded;
   with a failed or timed-out probe `recording` is absent and one warning is logged (jest).
2. Only h264/mp4 is advertised, and only with a hardware H.264 encoder in the probe (jest).
3. `meeting_engine_start` with another fps on a running engine or a pending start returns
   `meeting_engine_restart_required`; the same format stays idempotent (jest, shown red without the fps compare).
4. `meeting_engine_start` outside the advertised formats returns `meeting_program_format_unsupported` without
   side effects (jest).
5. The probe line's shape and codec names are pinned by ctest; the macOS helper prints a valid line.
6. `MeetingHelperManager.start()` stays free of awaits and never runs the probe (jest).

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
  - `program_formats` is reported independently of the probe (it does not depend on encoders, and the start gate
    must be synchronous); only `recording` is omitted when the probe fails.
  - 25 fps is advertised next to 30 although only 30 fps has run on a device.
- Handoff to human (if any):
  - Windows probe (`recording_probe_mediafoundation.cpp`) is unverified until Windows CI / device.

## Verification
- [x] Tests pass (jest 236 suites / 2839 tests; ctest recording_probe_test, options_test, control_server_test,
      program_stream_rpc_test; release contract tests 138)
- [x] Lint / type-check pass (`npm run lint`, `tsc -p apps/bridge/tsconfig.build.json`, `npm run build:protocol`)
- [ ] Browser-verified (if UI-affecting) - not applicable, no UI in this package
- [x] Behaviour change shown red before green (fps restart tests fail with the old width/height-only compare)
