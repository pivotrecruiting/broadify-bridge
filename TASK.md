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
- Round: 1/3
- Verdict: MUST-FIX (round 1) — shape correct, but the SHM path would deliver no frame on a real Windows box.
- Must-fix (open):
  - M1 `shm_frame_reader.cpp:143` opens the control mapping FILE_MAP_READ|WRITE but the SDDL (`vcam_shm_layout.cpp:346`) grants
    LOCAL SERVICE only GRGX → ACCESS_DENIED → permanent TCP fallback. Fix: separate SDDL for the CONTROL mapping with GWGR for LS
    (stream mapping stays read-only); or move consumer presence to a per-reader writable object. The selftest must run the reader
    with a token that is NOT the owner (at minimum assert via `GetSecurityInfo` that an ACE for S-1-5-19 grants the needed rights).
  - M2 `main.cpp:545` vs `raw_frame_server.cpp:222/229`: two writers on `vcamClientCount`. Split into `vcamShmReaderCount` +
    `vcamTcpClientCount` in `MeetingState`; `vcamClients = shm + tcp` in the pipeline snapshot.
  - M3 `vcam_shm_layout.cpp:246-251, 290-314, 406-415`: seqlock without atomics/fences (UB; reader re-check can be CSE'd away; plain
    stores may reorder). Access sequence/heartbeat/reader_count via `std::atomic<uint64_t>*` (or volatile + acquire/release fences);
    writer: seq=odd (release) → payload → seq=even (release); reader: seq1 (acquire) → copy → seq2 of the SAME slot (acquire),
    retry on mismatch/odd; "newest" chosen once, not re-run after the copy.
  - M4 `media_stream.cpp:168`: buffers pooled as RGB32 2D; NV12/YUY2 samples written into them → garbage for Lock2D consumers.
    Re-allocate the pool for the negotiated subtype on media-type change; NV12 splash Y=16/UV=128.
  - M5 `frame_pipeline.cpp:3113` + `vcam_shm_ring_win.cpp:148`: `capture_qpc` always 0 → QPC timestamp path dead. Pass the
    frame's QPC (or nowQpc at publish).
  - M6 `tests/vcam_shm_layout_test.cpp:75`: NV12 reference assertion wrong (block is not neutral; expected U/V ≈147 per BT.601
    integer formula). Fix the test data or expectation; add a torn-read case (writer interleaved, odd sequence) and a generation-change case.
  - M7 `main.cpp:368-373` selftest flaky (3 frames at fixed times vs reader mapping later). Publish at ~30 fps until the child exits
    (bounded 5 s); add the SDDL assertion (M1) and an activation-timing check (< 100 ms) in the ps1.
- Notes (do if cheap): mutex in `VcamShmRingWin` (close vs heartbeat/publish race); stale-reader detection (per-reader heartbeat or
  pid check) so a dead DLL cannot pin `vcamClients ≥ 1`; swizzle directly into the slot; cache the negotiated media type instead of
  2 COM calls per sample; `_tcpRunning` under `_lock`; status `shm_pending` until the ring is active; docs: `tcp` is not byte-for-byte
  (probe removed, NV12 first) — say so.

## Verification
- [ ] Tests pass
- [ ] Windows CI compile + shm selftest

### WP4 review round 2 — MUST-FIX (M3/M5/M6/M7 partial) + lifecycle gaps
- R2-1 `vcam_shm_ring_win.cpp:149`: heartbeat must ALWAYS be `nowQpc()` (never the camera capture QPC); frame timestamp = capture
  QPC only when it advanced, else `nowQpc()` (no duplicate timestamps).
- R2-2 `vcam_shm_layout.cpp` seqlock fences: writer — odd store, THEN a fence (seq_cst or release+compiler barrier) before payload
  writes, payload, release fence, even store; reader — seq1 load, acquire fence, copy, acquire fence BEFORE re-reading the same slot's
  seq2. Same for `writeControlRecord`/`readControlRecord`. Comment the Boehm pattern.
- R2-3 `scripts/test-windows-meeting-helper.ps1:58-69`: remove the helper-EXE banner timing; instead the SHM selftest reports
  `time_to_first_frame_ms` measured in the READER child (map → first frame) and the ps1 asserts < 100 ms.
- R2-4 tests: generation-change case (reader must re-open when `writer_generation` changes; DLL reader must act on it — implement
  in `shm_frame_reader.cpp`: re-read control on generation mismatch) and an interleaved-writer torn-read case.
- R2-5 stale reader pinning: per-reader liveness — each reader writes its pid + last-seen QPC into a small reader table in the control
  mapping (N=4 slots) instead of a bare counter; the helper derives `vcamShmReaderCount` = readers with last-seen < 3 s AND pid alive
  (`OpenProcess(SYNCHRONIZE)`); test for the derivation.
- R2-6 `vcam_shm_ring_win.cpp:251`: if the control mapping already exists (another helper/selftest), do NOT overwrite a live record
  (check writer pid alive + heartbeat fresh → log `vcam_shm_control_busy`, fall back to TCP); the selftest uses its own control name
  (`Global\BroadifyVcamControlSelftest`).
- Notes: `shm_pending` status until the ring is active; `_tcpRunning` under `_lock`.

### WP4 review round 3 — FINAL: one MUST-FIX (spec defect), applied as handoff fix 42f11993
R2-1..R2-6 resolved. Criteria: 1 met, 2 met on selftest, 3 met, 4 met, 5 met, 6 partial (documented: `tcp` is not byte-for-byte —
no activation probe, NV12 first, 5 s SHM retry log), 7 = Windows CI on `test-release/wp4-shm`.
MUST-FIX-1 (`vcam_shm_ring_win.cpp` `isProcessAlive`): `OpenProcess(SYNCHRONIZE)` on the Frame Server (LOCAL SERVICE) is denied for a
user process → readers counted dead → helper never publishes. Fixed in 42f11993: `PROCESS_QUERY_LIMITED_INFORMATION` +
`GetExitCodeProcess`, `ERROR_ACCESS_DENIED` = alive. Notes: Local-namespace detour on busy control mapping; selftest stdout
inheritance proven only by Windows CI. Decision for the human: include WP4 (default `shm`, auto TCP fallback) in rc.27 after CI green.

## Inherited from feature/win-stability-wp2

- KF-1 S1 never raw camera: (a) `compose/compositor.cpp` (D3D11 and CPU): an anchor-less, non-`emptyValid` mask is composited keyed
  (same as the `emptyValid` branch) — raw camera only when `cameraMask == nullptr`; (b) `frame_pipeline.cpp` Passthrough with a live
  worker (both decide() sites) and "no pair yet while model loaded" serve `lastGoodMask` ≤ 2 s, then a zero `emptyValid` mask (factor the
  Off-branch logic into one helper); null mask only for model-missing/keyer-disabled; (c) `subject_presence.h` Windows
  `acceptAfterMs` 1500 → 400, `emptyAcceptCoverage` = `kMinForegroundCoverage` (0.006); (d) async worker collapse hold bounded to
  12 results, then publish the real low-coverage mask. Tests: presence thresholds; retention→mask selection helper; compositor
  input selection (anchor-less → keyed).
- KF-2 S2 no trail: guided coefficient EMA default OFF (`BROADIFY_MEETING_GUIDED_COEFF_EMA` default 0 → no `blendAb` dispatch/copy);
  cadence `motionThreshold` 9 → 4 and `maxN` 4 → 2 (Windows); `BROADIFY_MEETING_FUSED_EMA_STATIC` default 0.72 → 0.85. Tests updated.
- KF-3 S3 load back to (better than) rc.18: guided work grid Windows 960 → 512 (`guided_work_size.cpp`); postprocess therefore at
  512×288; ORT intra-op 2 → 1; camera: default request ≤ 1280×720 @ 30 on Windows (env `BROADIFY_MEETING_CAMERA_MAX_HEIGHT`, default
  720; the compositor scales into the 1080p program) and rank subtype NV12/YUY2 BEFORE pixel distance so MJPG never wins (tests).
- KF-4 structural (the real regression): (a) `matting_common.cpp`: do NOT upscale the mask to the frame size — emit the cropped content
  region at model resolution (guided refine / CPU refine resample as they already do; verify every consumer of `mask.width/height`
  handles non-frame-sized masks: stabilizeFusedMask, lastGoodMask, postprocess, compositor upload, subject presence coverage);
  (b) replace `boxAverageChannel` (double, per-pixel bounds) by a single-pass integer block average (keep the letterbox mapping and
  the parity ctest, update expected values if needed); (c) `modnet_keyer.cpp`: governor and cadence receive `sessionRunMs` (GPU run
  only) — CPU pre/post time must never drive tier decisions; expose both in telemetry; (d) prebuild order: probe 512 LAST-built →
  instead seed from a 512 probe taken AFTER all builds (or build 512 first); tests for (c)/(d) where factorable.
- KF-5 S4 latency: early camera wake renders immediately when ≥ 0.9 × frameInterval elapsed since the last render start (phase-aligned
  to camera arrival, no grid wait); otherwise the frame is skipped (no sleep-to-grid); 60 fps cameras therefore render every other
  frame. Gating test.
- KF-6 self-check before any RC: (1) a 4-symptom regression review (read-only agent) with explicit verdicts S1–S4 against the final
  diff; (2) Windows CI via `test-release/wp2-consolidation` (MSVC + ctests + helper smoke) green; only then rc.25.
Acceptance: no code path composites the raw camera while the keyer is enabled and the model is loaded (review + tests); fused path
on a dGPU: guided grid 512, coeff EMA off, cadence ≤2, mask at model resolution; governor samples = GPU run only; camera ≤720p30 by
default; macOS unchanged; lint/jest/build/helper/ctests green.

### Consolidation review round 1 (4-symptom review) — verdicts S1 PARTIAL, S2 FIXED, S3 PARTIAL, S4 FIXED(caveat)
Must-fix:
- KR-1 `frame_pipeline.cpp` ~:2895-2903 fused-inference-failure frame: serve `selectRetainedOrEmptyMaskForLiveKeyer(lastGoodMask…)`
  + guided refine (like the warmup-in-flight branch) before setting `g_fusedKeyerDegraded` — never a null mask.
- KR-2 `frame_pipeline.cpp` ~:2409 (Windows): render without a new camera frame while keyer enabled and fused path owns the mask →
  composite `lastFusedPublishedMask` (or the helper on `lastGoodMask`), never a null mask.
- KR-3 `compositor.cpp` ~:1375-1386: the anchor-less→keyed change reaches Metal (macOS). Gate with `#if defined(_WIN32)`, keep the
  old behaviour in `#else`.
- KR-4 `matting_common.cpp` ~:34-45, 202: replace the integral-image build (3×uint64 planes per inference) by a true single-pass
  block sum into three accumulators over disjoint integer-bounded blocks; no per-inference allocation; keep the brute-force parity test.
- KR-5 `camera_mediafoundation.cpp` reopen/scheduleReopen: apply `clampCameraCaptureRequest` (≤720p30) on the reopen path too.
- KR-6 `camera_media_type_rank.h`: pixel floor (candidate ≥ 50 % of requested pixels) BEFORE the subtype rule; add the real C920
  list test (YUY2 1280x720@10, YUY2 640x480@30, MJPG 1280x720@30, MJPG 1920x1080@30; request 720p30 → MJPG 720p30).
- KR-7 `meeting-helper-manager.ts` forwarded env: add `BROADIFY_MEETING_CAMERA_MAX_HEIGHT`, `BROADIFY_MEETING_GUIDED_COEFF_EMA`,
  `BROADIFY_MEETING_MASK_WORK_WIDTH`, `BROADIFY_MEETING_FUSED_EMA_STATIC` (jest list test).
- KR-8 docs `meeting-keyer-windows.md` / `meeting-windows-performance.md`: 512 grid, coeff EMA off, maxN 2 / motion 4, intraOp 1,
  mask at model resolution, `CAMERA_MAX_HEIGHT`.
Notes (do if cheap): S4 early-wake factor 0.9 → 0.75 (jitter); skip `CopyResource(planePrevAb)` when coeff EMA off; tests for the
worker collapse bound, the fused-failure frame and the reopen clamp (factor as free functions); remove dead `sampleBilinearCrop`.

### Consolidation review round 2 — MF-1..MF-6 (fixed in a71c6fa9)
MF-1 no explicit capture of the static `lastFusedPublishedMask`; MF-2 idle-render mask supply without forcing a render; MF-3 no
early-wake consume/continue — wait until min(nextFrameAt, lastRenderStart + 0.75·interval), then render; MF-4 Windows null-mask
catch-all before `renderProgramFrame` (lastGoodMask ≤ 2 s, then empty); MF-5 macOS `#else` byte-for-byte; MF-6 intraOp doc.

### Consolidation review round 3 — FINAL: PASS
S1 raw camera on exit: PASS (zero Windows paths; catch-all ages honestly → background-only after 2 s). S2 ghost: PASS. S3 load:
PASS (no busy loop in any state: no camera / 30 fps / 60 fps / keyer off / idle). S4 latency: PASS (render on camera arrival at
≥ 0.75·interval; inference on every rendered frame). Notes: test label for the 60 fps case corrected; catch-all sets no stage
telemetry (cosmetic). Windows CI on `test-release/wp2-consolidation` is the release gate for rc.25.

## rc.25 field result (22.08.2026) — VCam-aware keyer policy + grey/churn fixes — VF-1..VF-7 (→ rc.26)
Field: keying better without Teams; GHOST only while Teams/VCam streams; Teams shows "grey"; laptop gets louder over time.
Diagnosis: (F1) Teams' encoder + the TCP VCam path (~8 copies/frame) push `sessionRunMs` → cadence N=2 / governor → Lite256 =
live frame paired with a 66–132 ms-old mask + dynamic dilation + 5 s fused/async overlap → trail; oscillation with doubling holdoff.
(F2) most likely NOT the DLL splash but the helper's background-only render (zero `emptyValid` mask) during the prolonged first-load
hold / inference failure under Teams load; second candidate `vcamRawRunning=false` disarm loop; third an old DLL still loaded in the
Frame Server (no build stamp in vcam.log). (F3) thermal/governor feedback + camera stall-reopen loop + raw-server thread churn.
- VF-1 contention-robust keyer policy (Windows): while `vcamClients > 0` pin cadence `maxN = 1` (never reuse a mask for a live frame);
  degrade by TIER only (512→320→256 fused) before any async tier; Lite256 reachable only after ≥ 30 consecutive over-budget samples at
  fused 256; in Lite/Off composite the PAIRED frame (`selectedPair->frame`) instead of `latestCameraFrame` (no live-snap of aged masks;
  accept ≤100 ms latency instead of ghost); `dynamicDilation` off on Windows; fused EMA static 0.85 → 0.92; no fused/async overlap
  double-inference while a VCam client is connected (cut over on first pair or after 1 s). Tests: governor transition rules, cadence pin,
  pairing selection.
- VF-2 first-load / not-ready: retained `lastGoodMask` hold up to 5 s during warm-up/failure (not 2 s); while no mask ever existed
  composite the camera keyed with a FULL (alpha 255) mask? — NO: background-only is the spec'd behaviour; instead expose it: status
  `keyer_ready:false`, degradation_stage `keyer_loading`, and a helper event `keyer_not_ready` with the reason so the operator/webapp can
  show "Keyer lädt". Reduce the hold itself: build only the seeded tier + 256 at first load (`PREBUILD_TIERS` default `active,256`), the
  remaining tier lazily in the background after the first frame.
- VF-3 raw server: send a heartbeat (last stored frame or a 1-frame render-on-connect) even when `payload.empty()`; emit
  `meeting_vcam_raw` event `no_frame_on_connect` if `sent_frames == 0` after 2 s; join/reap finished worker threads each accept
  iteration (`workers` vector must not grow).
- VF-4 diagnosability: DLL logs a build stamp (git sha + build time via a generated header) on first `VcamLog`; helper events on every
  `output.vcam.raw.start/stop`, on every governor tier / cadence change and on `camera_stalled` reopen count per hour.
- VF-5 camera stall loop: reopen only after 2 consecutive stall windows (3 s) and back off 5 s → 30 s between reopens while the camera
  keeps stalling; never reopen while `vcamClients > 0` and frames arrive at ≥ 10 fps.
- VF-6 installer (`build/windows-installer.nsh` + `deploy-vcam.ps1`): stop the `FrameServer`/`FrameServerMonitor` services (or warn and
  require a reboot) when replacing `broadify-vcam.dll`; NSIS smoke unchanged otherwise.
- VF-7 docs + runbook: "grey in Teams" triage order (keyer_ready → raw stream armed → DLL build stamp), env knobs, VCam-aware policy.
Acceptance: unit tests for VF-1 rules and VF-5 backoff; no `workers` growth (test with a fake accept loop or review); macOS unchanged;
lint/jest/build/helper/ctests green; then 4-symptom review (F1/F2/F3) + Windows CI test branch → rc.26.

### VF review round 1 — F1 PARTIAL, F2 NOT (diagnosability only), F3 PARTIAL
Must-fix:
- VR-1 `vcam-helper/windows/media_source.cpp` ~:63-83: REMOVE the blocking geometry probe. Use handshake geometry if available within
  ≤100 ms; on connect failure return immediately with 1920x1080; never sleep through 20×100 ms. Give `RawFrameClient` a
  "connect attempt finished" signal (atomic state: connecting/connected/failed). This is the prime suspect for "Teams takes forever to
  open" and removes the probe's side effects on `vcamClientCount`/policy and the `no_frame_on_connect` noise.
- VR-2 `build/windows-installer.nsh`: stop `FrameServer`/`FrameServerMonitor` in `customInit` (runs in `.onInit`, BEFORE file
  extraction), then poll `sc query` for STOPPED (bounded ~5 s) before proceeding; keep the reboot fallback; NSIS smoke green.
- VR-3 `pipeline/compositor_input_selection.cpp` ~:43-49 + callers (`frame_pipeline.cpp` ~:2049, ~:2206): the non-VCam async path
  must return `PairedFrame` (prior behaviour); `LatestCameraFrame` only when the live-snap can actually run
  (`guidedRefineAvailable() && liveSnapEnabled()`); fix the test expectation.
- VR-4 `preview/raw_frame_server.cpp` ~:305: implement the heartbeat when no payload exists (synthesized record with the last stored
  frame if any, else a zero-size heartbeat the DLL accepts as keep-alive and ignores for display) so the DLL's 5 s recv timeout
  cannot fire while the stream is armed; DLL side: accept the keep-alive record (version-tolerant). Also: when `vcamRawRunning` is
  false, answer the handshake with a distinct HTTP status (e.g. 503 + `X-Broadify-Stream: disarmed`) and let the DLL back off to 3 s
  immediately instead of treating it as a successful connection (kills the 250 ms reconnect storm).
Notes: rename `vcamAwarePolicy` → `tierFirstPolicy`; `reopen_count_hour` → lifetime counter naming; reaping test should exercise
the real worker vector; build stamp is configure-time (document).

## rc.27 field result (22.08.2026): BLACK in Teams — diagnosis + fix set (→ rc.28)
Diagnosis (code + field vcam.log): (1) the streaming DLL instance runs in the Frame Server svchost as LOCAL SERVICE and CANNOT write
`%ProgramData%\Broadify\vcam.log` (file owned by the user) → we have never seen a single stream-side log line; only the in-process
activation probe logs. (2) Creating a `Global\` file mapping from an unelevated user process requires `SeCreateGlobalPrivilege` →
`CreateFileMappingW(stream) failed error=5` on every normal desktop → helper falls back to TCP (CI runner is elevated, so the
selftest passed). (3) On the TCP fallback the DLL now advertises NV12 first and writes NV12 into pooled 2D buffers (rc.26 used RGB32
+ MFCreateMemoryBuffer) → the black picture is the NV12 splash / empty NV12 samples on the LS instance. (4) Even with SHM, "mapping open,
heartbeat fresh, zero frames" is a stable state with no TCP fallback (helper publishes only when vcamClients>0).
- BF-1 `vcam_log.cpp`: create `%ProgramData%\Broadify` and the log with an explicit DACL (Authenticated Users + LOCAL SERVICE:
  modify/append; owner full); if the existing file is not writable, fall back to `vcam-<pid>.log` in the same dir; log `build_stamp`
  + process identity (session id, user = LS or interactive) on first line.
- BF-2 `media_stream.cpp`: media types RGB32 FIRST (rc.26 behaviour and buffers: `MFCreateMemoryBuffer` for RGB32), NV12 second, YUY2
  third; NV12 path stays but is only used when the consumer selects it. Start the TCP client in `Start()` immediately when
  `!hasMapping()` (rc.26 timing), not lazily in RequestSample.
- BF-3 `shm_frame_reader.cpp` / `media_stream.cpp`: "mapping open but no frame within 2 s of open" → treat like stale heartbeat
  (close mappings, TCP fallback, retry SHM every 5 s).
- BF-4 helper `frame_pipeline.cpp` ~:3198: publish into the ring whenever the ring is active and `vcamRawRunning` (drop the
  `vcamClients > 0` term for the ring write only); `output.vcam.raw.stop` closes the ring (DLL sees staleness); route
  `vcam_shm_control_busy` through `emitHelperEvent`; seed `vcamWriterGeneration` from pid+tick.
- BF-5 Global namespace reality: document in `virtual-camera-windows.md` that SHM requires a process with `SeCreateGlobalPrivilege`
  (today: elevated helper only) and that unelevated installs run TCP; status `vcam_transport_selected reason=global_namespace_privilege`
  must say so explicitly (map error 5 to that reason). Design follow-up WP4b (separate task): the DLL (service, holds the privilege)
  creates the `Global\` ring with an ACL for the interactive user's SID (WTSGetActiveConsoleSessionId + WTSQueryUserToken → SID) and the
  helper OPENS it — reverse ownership.
- BF-6 ctest for the "no frame within 2 s" reader rule; ps1: the SHM selftest additionally runs the reader with a restricted token if
  possible — else document the CI blind spot explicitly.
Acceptance: rc.28 behaves like rc.26 in Teams on an unelevated desktop (RGB32 TCP) with full stream-side logging; SHM engages only
where the privilege exists and never leaves the consumer without frames.

### BF review round 1 — MUST-FIX
- BF-R1 (M1) `media_stream.cpp`: descriptor offers RGB32 ONLY (like rc.26 tag v0.24.0-rc.26 — no NV12/YUY2, no FRAME_RATE_RANGE attrs)
  unless `HKCU\Software\Broadify\VCam\OfferNv12` DWORD=1 (read once at Start; documented as experiment flag). Log ONCE per Start the
  negotiated subtype + buffer kind (`stream_type subtype=RGB32 buffer=memory`) in RequestSample on first sample, and on every SetCurrentMediaType.
- BF-R2 (N2) `vcam_log.cpp` SDDL: grant LS + Administrators + owner on the log FILE only (and `.1`), no OICI on the directory; keep dir inheritance.
- BF-R3 (N3) never log SIDs: identity as LOCAL_SERVICE / SYSTEM / interactive / other.
- BF-R4 (N1) if shared vcam.log is not writable and not owned: try rename to `vcam-legacy.log` before per-pid fallback; field doc mentions per-pid files.
- BF-R5 (N4) reset `_lastShmSequence` on SHM reopen. (N5) doc note: with SHM armed the ring is written at full cadence even without readers.
