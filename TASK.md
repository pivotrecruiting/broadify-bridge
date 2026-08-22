# Task: WP4 — Windows virtual camera transport: shared memory instead of TCP (Stufe B-2)

## Raw request
User 22.08.2026: the webapp preview shows the keyed presenter while Teams shows grey → frames do not reach the DLL over the TCP path;
Teams takes "forever" to open (the DLL's 2 s geometry probe blocks every camera enumeration when the stream is unreachable) and the
laptop gets slow/loud over time (reconnect churn). Third grey incident caused by the TCP transport → replace it (design doc
`docs/bridge/architecture/meeting-windows-stage-b-design.md` section 3). User wants more built per cycle: WP4 is pulled forward.

## Context
- Worktree / branch: `broadify-bridge-worktrees/win-stability-wp4` / `feature/win-stability-wp4`, base `feature/win-stability-wp2`.
- Host macOS: Windows C++ compiles only in CI (test branch `test-release/wp4-shm`). macOS VCam (CMIO extension + TCP) untouched.
- Official guidance (Microsoft, Frame Server Custom Media Source): the source runs as LOCAL SERVICE in Session 0; creation must be
  cheap (no work before `IMFMediaSource::Start`); samples via `MFCreateSample` + `MFCreate2DMediaBuffer` (system memory) with QPC
  timestamps; NV12 preferred, YUY2 for legacy. Shared named objects must be `Global\` with an ACL granting LOCAL SERVICE read access.
- Transport selection env `BROADIFY_MEETING_VCAM_TRANSPORT=shm|tcp`, default `shm`; automatic fallback to TCP if the mapping cannot
  be created/opened (logged). TCP code stays for one release.

## Plan (one commit per block)

### Block A — Shared ring (helper side, `preview/vcam_shm_ring_win.{h,cpp}` + platform-neutral `preview/vcam_shm_layout.{h,cpp}`)
A1. Layout (platform-neutral, testable): header {magic 'BFSM', version 1, width, height, fps_num/den, format (BGRA8=2, NV12=3),
    slot_count 3, slot_stride, writer_pid, writer_generation, heartbeat_qpc}; slots {sequence (u64, odd while writing = seqlock),
    capture_qpc (u64), size, data[]}. Reader rule: read the slot with the highest even sequence, re-check after copy.
A2. Helper creates `Global\BroadifyVcam-<token>` file mapping + `Global\BroadifyVcamFrame-<token>` event with an explicit
    security descriptor: owner full, `NT AUTHORITY\LOCAL SERVICE` GENERIC_READ|SYNCHRONIZE, Administrators full (SDDL). Token = helper
    pid + start tick. If `Global\` creation fails (no `SeCreateGlobalPrivilege`) fall back to `Local\` AND log — note: Session-0
    readers cannot see `Local\`; in that case the transport falls back to TCP automatically (A5).
A3. Publish: the pipeline writes each program frame into the next slot (seqlock), sets the event. BGRA8 in WP4 (NV12 is WP3's
    compositor output; keep a format field so WP3 can switch). The existing `PreviewFrameStore::publish` stays for MJPEG preview.
A4. Discovery: the helper writes `HKLM\SOFTWARE\Broadify\VirtualCamera\Stream` values {MappingName, EventName, Width, Height, Fps,
    Format, WriterPid, Generation} — HKLM write requires elevation: NOT acceptable at runtime → use `HKCU`? (invisible to LOCAL SERVICE)
    → use a well-known `Global\BroadifyVcam-<CLSID>` name with a small discovery mapping (`Global\BroadifyVcamControl`) that contains
    the current stream mapping name + generation, created by the helper with the same ACL; the DLL opens the control mapping by its
    fixed name. No registry writes at runtime.
A5. Transport arbitration in `vcam_controller.cpp`/raw server: `shm` default; if A2 fails → `tcp` (existing server) and status
    `vcam_transport: "tcp"|"shm"` in `output.vcam.status` + helper event `vcam_transport_selected` with reason.

### Block B — DLL reader (`vcam-helper/windows/shm_frame_reader.{h,cpp}`, `media_source.cpp`, `media_stream.cpp`)
B1. `MediaSource::Initialize`: NO blocking probe. Read geometry from the control mapping if present (microseconds); else advertise
    the default 1920×1080@30. Never sleep in ActivateObject.
B2. `MediaStream::Start`: open the stream mapping + event (by name from the control mapping); reader thread waits on the event (with
    1 s timeout) and copies the newest even-sequence slot into the pooled MF buffer (`MFCreate2DMediaBuffer`, RGB32 stride). Sample
    time = slot capture_qpc converted to MF time (10 MHz) with the existing monotonic clamp; duplicates (no new sequence) re-deliver the
    last good frame with +duration; before the very first frame: splash.
B3. If the mapping is absent/unreadable at Start or the writer generation/heartbeat stops for > 3 s: fall back to the TCP client (existing
    `RawFrameClient`) transparently and log `vcam_reader_transport tcp reason=…`; re-check the mapping every 5 s and switch back.
B4. Media types: RGB32 (existing) + NV12 (converted in-DLL with a SIMD BGRA→NV12 if the helper writes BGRA; when the helper writes NV12
    (WP3) pass-through) + YUY2 — advertise NV12 first. `MF_MT_FRAME_RATE_RANGE_MIN/MAX` 15–30.
B5. Build stamp in vcam.log at first log line (git sha + build time from a generated header) — shared with the helper's stamp from VF-4
    if already present on the base branch; otherwise add it here.

### Block C — Lifecycle
C1. Helper: create the ring on `output.vcam.raw.start` (i.e. on arm) and keep it for the helper lifetime; `writer_generation` increments
    on every engine (re)start; heartbeat_qpc updated each frame and every 500 ms when idle, so the DLL can detect a dead writer.
C2. DLL: consumer presence = stream running; report it to the helper via a small `Global\BroadifyVcamConsumer-<token>` event/counter
    (or the helper polls a `reader_count` field in the control mapping the DLL increments/decrements under the seqlock) so the helper
    keeps `vcamClients` semantics (render only while a consumer streams) without TCP connection counting.
C3. Bridge: no change to RPC contracts except `output.vcam.status` gaining `transport`; docs for `vcam_transport_selected`.

### Block D — Tests, selftest, docs
D1. ctests: layout/seqlock reader-writer on a heap buffer (torn-read detection, newest-even rule, generation change), SDDL string
    builder, discovery record round-trip, BGRA→NV12 converter vs reference.
D2. Windows smoke (CI `test-windows-meeting-helper.ps1`): helper `--vcam-shm-selftest` creates the mapping with the ACL and a second
    process (the helper itself with `--vcam-shm-reader-selftest`) opens it read-only and reads 3 frames; asserts ACL contains LOCAL
    SERVICE (cannot impersonate LOCAL SERVICE in CI — assert the SDDL via `GetSecurityInfo`).
D3. Docs: `docs/bridge/features/virtual-camera-windows.md` (transport, discovery, fallback, triage), runbook update ("grey" triage now:
    transport → generation/heartbeat → build stamp), design doc status.

## Acceptance criteria
1. With `shm` the DLL never sleeps in activation; Teams enumeration returns immediately (review; selftest timing in ps1 < 100 ms).
2. Frames reach the DLL without TCP (selftest reads 3 frames from a second process); torn reads impossible (ctest).
3. TCP fallback is automatic and logged when the mapping cannot be created/opened; status `vcam_transport` honest.
4. No per-connection threads/churn in the helper for `shm` (review); worker reaping for the remaining TCP path (VF-3 on base).
5. Sample timestamps from capture QPC, monotonic; NV12 advertised first, RGB32 still offered.
6. macOS untouched; flag `tcp` restores rc.25 behaviour byte-for-byte.
7. lint/jest/build/macOS helper/ctests green; Windows CI (test branch) compile + smoke green before any RC.

## Review
- Round: 0/3
- Verdict: (pending)

## Verification
- [ ] Tests pass
- [ ] Windows CI compile + shm selftest
