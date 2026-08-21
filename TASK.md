# Task: WP0 — Windows meeting stability: grey virtual camera, camera dropouts, VCam robustness

## Raw request
User (21.08.2026, after the read-only deep analysis of rc.11/rc.12): "lass uns damit beginnen … ich habe
noch einen zusätzlichen Fehler auf Windows, den wir direkt mit beheben müssen (Stand 24 rc 12): Die
virtuelle Kamera wird zwar in Teams erkannt, sendet aber graues Bild. Baue sauber … beide Maßnahmen
(Stufe A + Stufe B), sodass wir wirklich alles sauber haben."

WP0 is the first of several work packages. It targets symptom 3 ("camera drops out completely") and the
rc.12 grey-picture bug, so a field-testable RC exists before the performance work (WP1+) lands.

## Context
- Customer / project: Broadify Bridge, Windows 11 laptops (Intel iGPU + GTX 1660 Ti; iGPU-only).
- Worktree / branch: `broadify-bridge-worktrees/win-stability-wp0` / `feature/win-stability-wp0`
- Base branch: `feature/vcam-rc10` (= v0.24.0-rc.12, integration branch of the open VCam PRs #130–#137).
  Stacked on purpose; PR target is `dev` after the stack ahead of it.
- Host is macOS: Windows C++ (meeting-helper, vcam DLL) is NOT compiled locally. CI (`test-release.yml`,
  windows-2022) compiles both; the user field-tests the RC. Keep Windows-only code behind `#ifdef _WIN32`
  exactly like the existing code, and keep macOS builds green locally.
- Analysis report with file:line evidence: https://claude.ai/code/artifact/da4506cb-1180-4e8c-9798-5ac541a10202
  (sections 03 and 07). All paths below are relative to `apps/bridge/`.

## Plan
Implement in the order below; each block is a separate commit with a conventional-commit message.

### Block A — Windows VCam DLL (`native/vcam-helper/windows/`)
A1. `raw_frame_client.cpp`: set `SO_RCVTIMEO` (5 s) and `SO_SNDTIMEO` (5 s) and `SO_KEEPALIVE` on the socket
    before `connect()`; treat a timeout in the handshake or in `recvExact` as a disconnect (log with
    `WSAGetLastError()`), then back off and reconnect. Log connect() failures (rate-limited: first failure and
    then once per backoff step change) with the error code.
A2. `raw_frame_client.cpp`: wrap the whole body of `run()` in `try/catch(...)` (log + treat as disconnect) and
    bound `payload.resize()`/`latest_` copies: allocate once per geometry change, reuse buffers (no per-frame
    8 MB allocation). Never let an exception escape the thread.
A3. `media_stream.cpp`: wrap every COM method body (`RequestSample`, `Start`, `Stop`, `Shutdown`,
    `GetMediaSource`, `GetStreamDescriptor`, event methods) in `try/catch` returning `E_FAIL` — an exception
    escaping a COM method terminates the Frame Server service (all cameras on the machine).
A4. `media_stream.cpp`: allocate the MF sample buffer via a reused `IMFMediaBuffer` pool (or
    `IMFVideoSampleAllocator`) instead of `MFCreateMemoryBuffer` per sample. Use `copyLatestIfNew` semantics
    to skip the 8 MB deep copy when the sequence did not change: if no new frame, re-emit the previous
    sample content (last good frame), NOT the splash. The splash is only used before the FIRST good frame
    of a connection.
A5. `media_stream.cpp` / `raw_frame_client.cpp`: staleness no longer switches to the splash once a good frame
    was seen; it only logs (rate-limited) after 2 s and 10 s without frames. (Frozen last frame is the correct
    behaviour; a grey screen is not.)
A6. `media_stream.cpp`: `Stop()`/`Shutdown()` must not call `_client->stop()` (thread join) while holding
    `_lock`; release the lock first. `RawFrameClient::stop()` must `closesocket()` the pending socket (not only
    `shutdown()`), so a blocked `connect()`/`recv()` returns immediately.
A7. `dllmain.cpp`: `Activator::ShutdownObject()` releases `_source` (calls `Shutdown()` on it). Break the
    `MediaSource` ↔ `MediaStream` strong reference cycle (stream holds a weak/raw back-reference, cleared in
    Shutdown) so a leaked source cannot keep a raw-frame connection alive.
A8. `vcam_log.cpp`: prefix each line with local wall-clock time (`YYYY-MM-DD HH:MM:SS.mmm`), PID and TID; cap
    the log at 5 MB (rename to `vcam.log.1` and start over). Keep the path.
A9. `dllmain.cpp`: `Activator::ActivateObject` must create a fresh `MediaSource` when the cached one has been
    shut down (a re-activation of a shut-down source returns `MF_E_SHUTDOWN`).
A10. Media types stay RGB32 only in WP0 (NV12/YUY2 is WP4).

### Block B — Helper raw-frame server (`native/meeting-helper/src/preview/raw_frame_server.cpp`)
B1. Serve each accepted client on its own thread (detached, with a per-client `running` check), so a stalled
    or leaked client can never block `accept()`. Keep `VcamClientCounter` semantics (count = live clients).
B2. Set `SO_SNDTIMEO` (2 s) on accepted client sockets; a send timeout disconnects that client only.
B3. Detect peer close: poll the client socket with `recv(MSG_PEEK)`/`select` (non-blocking) each loop
    iteration so a half-open client is dropped even while no new frames arrive.
B4. Heartbeat: while a client is connected and no new frame arrived for 1000 ms, re-send the last frame
    (same payload, new sequence) so the DLL's staleness never trips on a legitimately static program.
    Implement in the server (re-send cached last payload), not in the pipeline.
B5. Bind with `SO_EXCLUSIVEADDRUSE` on Windows (instead of `SO_REUSEADDR`, which on Windows allows a second
    bind on a live listener); keep `SO_REUSEADDR` on POSIX.
B6. Log socket errors with the error code in the existing `meeting_vcam_raw` JSON events (`event":"error"`).

### Block C — Helper camera capture (`native/meeting-helper/src/capture/camera_mediafoundation.cpp`)
C1. `OnReadSample`: on `FAILED(hrStatus)` or `MF_SOURCE_READERF_ENDOFSTREAM` do NOT silently stop. Record an
    error state (hr, timestamp), emit a helper event `{"type":"camera_capture_error","hr":"0x…","reason":…}`
    and schedule a reopen of the same device (by symbolic link) with backoff 500 ms → 1 s → 2 s → 5 s (cap),
    unlimited attempts while the camera is supposed to be running. Reopen runs on the capture management
    thread, never on the MF callback thread.
C2. `OnEvent`: handle `MEVideoCaptureDeviceRemoved` and `MEError` the same way (reopen with backoff).
C3. Frame-age watchdog: in the program loop (`frame_pipeline.cpp`) or in the camera source, if the newest
    camera frame is older than 1500 ms while `cameraRunning`, set `state.cameraStalled = true`, emit
    `{"type":"camera_stalled","age_ms":…}` once, and trigger the same reopen path. Clear the flag and emit
    `camera_recovered` on the next frame. Expose `camera_stalled` in `state.get` (and therefore in the bridge
    status snapshot).
C4. Stable device identity: `camera.start`/`camera.select` accept an optional `stable_key` (the symbolic
    link already exported by `camera.list`); when present it wins over `camera_index`. Index remains as
    fallback. Bridge client (`src/services/meeting/meeting-helper-client.ts`) passes `stable_key` through when
    the caller supplies it; the command router accepts it in the zod schema (`meeting_camera_start` /
    `meeting_camera_select`).
C5. Idempotent `camera.start`: in `control_server.cpp` (`camera.start` handler) return success without
    touching the device when the same device (by symbolic link or resolved index) is already running with
    the same requested geometry. Add a `"reopened": false/true` field to the response.
C6. Logging: emit helper events for camera open start/success/failure (with hr and the device friendly name —
    no PII beyond the device name), close, and reopen attempts.

### Block D — Bridge lifecycle (`src/services/meeting/`)
D1. `meeting-helper-manager.ts` `restoreRuntimeConfig`: after a crash restart, if the virtual camera was
    running before the crash (`lastVirtualCameraStatus` / a recorded `virtualCameraStart` call), re-arm it
    via `client.virtualCameraStart({ allowElevation: false })` AFTER the camera calls; failures are warn-only
    and produce the existing `vcam_*` error events.
D2. `releaseStaleMeetingHelperVcamPort`: implement the Windows branch (`netstat -ano -p tcp` or
    `Get-NetTCPConnection -LocalPort` via PowerShell → PID → `tasklist`/`Get-Process` to confirm the image name
    is `meeting-helper.exe` and the PID is not our current helper → `taskkill /PID /F`). Same logging as the
    darwin branch. Unit-test the parsers with fixture output.
D3. `vcam_raw_bind_failed` from the helper must fail `start()` (reject the ready promise with a typed error
    `vcam_raw_bind_failed`) instead of leaving the manager in `running`. Also emit it via `emitHelperEvent` in
    the helper so it reaches the event-log sidecar.
D4. Control-channel watchdog: count consecutive RPC `timeout` errors of the status poll as failures too (same
    threshold 5), so a wedged-but-connectable helper is restarted.
D5. Windows kill path: before `child.kill()` on win32, attempt a graceful `control.shutdown` RPC with a 3 s
    timeout (so `IMFVirtualCamera::Stop/Remove` and `recorder.stop()` run); only then terminate.
D6. Electron `powerMonitor` (`src/electron/main.ts`): on `resume` / `unlock-screen`, if the meeting engine is
    running, send a bridge-local request that triggers the helper camera reopen path (new RPC
    `camera.reopen`, no-op when not running). Keep it minimal.

### Block E — Docs
E1. Update `docs/bridge/features/virtual-camera-windows.md` (stream lifecycle, heartbeat, timeouts, last-frame
    behaviour) and `docs/bridge/support/vcam-runbook.md` (new log lines + what "grey" now can and cannot mean).
E2. Update `docs/bridge/subsystems/output-helper.md` or the meeting-helper doc that describes camera
    lifecycle with the reopen/backoff/watchdog behaviour.

## Acceptance criteria
0. rc.12 grey picture: with the helper running and a consumer connected, no state short of "no frame ever
   received on this connection" shows the 0x1e splash. The diagnosed chain (camera reader dies silently →
   no publish → stale → splash; server never notices the dead client) is closed at every link: C1/C3 (camera
   reopen + stall event), B4 (server heartbeat), A5 (last good frame instead of splash), B1/B3 (multi-client,
   dead-client detection), A1 (handshake timeout).
1. DLL: no code path delivers the 0x1e splash after the first good frame of a connection; staleness and size
   mismatch only log. (Code review + unit test of the frame-selection logic if it is factored into a
   testable function.)
2. DLL: `raw_frame_client.cpp` sets `SO_RCVTIMEO`, `SO_SNDTIMEO`, `SO_KEEPALIVE`; a handshake that never
   completes ends within ≤ 6 s with a logged disconnect and a reconnect.
3. DLL: no COM method and no thread entry can propagate a C++ exception (grep: every `STDMETHODIMP` body and
   `run()` are wrapped).
4. DLL: per-sample allocation is gone (`MFCreateMemoryBuffer` not called per `RequestSample`).
5. Helper raw server: two simultaneous clients are both served (ctest or a TS integration test against the
   macOS build of the helper: connect two raw clients, both receive headers + frames).
6. Helper raw server: a connected client receives a frame at least every ~1 s even when the program is static
   (test with the macOS helper: start in `static_output`/idle with a consumer, assert frame cadence).
7. Camera capture (Windows code, CI compile + review): `OnReadSample` error and `MEVideoCaptureDeviceRemoved`
   lead to a logged reopen with backoff; no silent stop remains (`return S_OK; // stop re-arming` is gone).
8. `camera_stalled` appears in `state.get` and in the bridge status snapshot; covered by a jest test of the
   status mapping and by a ctest/unit test of the age logic (platform-neutral).
9. `camera.start` twice with the same device and geometry does not reopen the device (helper unit test on the
   macOS camera path or a control-server test with a stub camera source; response contains `reopened:false`).
10. `stable_key` is accepted end-to-end (zod schema test + helper control test) and wins over `camera_index`.
11. Bridge: after a simulated helper crash with VCam previously running, `restoreRuntimeConfig` calls
    `virtualCameraStart` (jest, existing manager test harness).
12. Bridge: Windows stale-port release parses `netstat`/PowerShell fixture output correctly and only kills
    `meeting-helper.exe` PIDs that are not the current helper (jest with fixtures, `platform()` mocked).
13. Bridge: `vcam_raw_bind_failed` rejects `start()` with a typed error (jest).
14. Bridge: 5 consecutive status-poll timeouts trigger the restart path (jest).
15. `npm run lint`, `npm run test:jest` (root and `apps/bridge`), `npm run build`, `npm run build:meeting-helper`
    (macOS) and `npm run test:meeting-helper-native` pass locally. Windows compile is verified by CI on the RC.
16. Docs updated (E1, E2). Comments/JSDoc in English. No secrets or PII in logs.

## Review
- Round: 1/3
- Verdict: MUST-FIX (round 1)
- Must-fix (open):
  - M1 `camera_mediafoundation.cpp` reopen thread: use-after-free / ghost reopen. Add `std::atomic<uint64_t> sessionGeneration_`
    bumped in `stop()`/`startSet()`; the reopen lambda captures the generation and re-checks `running_ && generation == sessionGeneration_`
    AFTER the sleep and again under the lock before installing. Keep `std::thread reopenThread_` and join it in `stop()` outside `mutex_`
    (or use a shared_ptr token instead of `this`). Never spawn a second reopen thread while one is alive.
  - M2 Reopen must resolve the SAME device by symbolic link (`cameraId`), not by index; derive the index from the match.
  - M3 Do not destroy the old `MfCaptureSession` (Flush + 2 s wait) under `mutex_`; swap it out under the lock and let it die outside.
  - M4 `frame_pipeline.cpp` watchdog: keep `camera_stalled` state/event platform-neutral, but call `camera.reopen(...)` only
    `#if defined(_WIN32)` (macOS AVFoundation must not be restarted synchronously on the program thread).
  - M5 `media_source.cpp`: wrap EVERY STDMETHODIMP body in try/catch → E_FAIL (incl. `Start`, `GetStreamAttributes`; use `try_as`
    or catch around `.as<>()`); also `Activator`/`ClassFactory` methods in dllmain.cpp. Add `~MediaSource() { Shutdown(); }` so the
    stream's raw back-pointer can never dangle.
  - M6 `meeting-helper-manager.ts`: `vcam_raw_bind_failed` must reject `start()` deterministically: set `this.vcamRawBindFailed`
    in `handleStdoutLine`; after `await this.waitForReady()` in `startInternal` throw `MeetingHelperRequestError("vcam_raw_bind_failed", …)`
    if set (reset per start); kill the helper in that case. Helper: emit the bind failure via `emitHelperEvent` (sidecar) in addition to stdout.
  - M7 Missing tests required by criteria 8, 9, 10, 11, 13: jest test that `camera_stalled` reaches the status snapshot; ctest for the
    frame-age logic (factor the predicate into a platform-neutral function); control-server/helper test for idempotent `camera.start`
    (`reopened:false`) and `stable_key` precedence; zod schema test for `MeetingCameraSelectionSchema`; manager test: crash restart with
    VCam previously armed → `virtualCameraStart` called after the camera calls; manager test for M6.
  - D6 (was deviated): implement the minimal powerMonitor path: bridge route `POST /meeting/camera/reopen` (guarded by
    `enforceLocalOrToken`, calls `client.cameraReopen()` only when the engine is running, returns `{ok, reopened}`) and in
    `src/electron/main.ts` `powerMonitor.on("resume"|"unlock-screen")` → `bridgeApiRequest("/meeting/camera/reopen", {method:"POST"})`
    (existing `createBridgeApiRequest`). Jest test for the route.
- Notes (non-blocking, do them if cheap):
  - raw_frame_server.cpp: `SO_RCVTIMEO` 5 s for the per-client `readRequest`; keep worker threads in a vector and join them after
    `running` clears (no detached threads touching state after `WSACleanup`).
  - Heartbeat sequence: tag with the high bit (`seq | (1ull << 63)`) so a real frame can never collide with a heartbeat sequence.
  - media_stream.cpp: avoid the per-new-frame 8 MB local `RawFrame` (member buffer or `copyLatestIfNewInto`).
  - meeting-helper-manager.ts: after `taskkill` wait for the PID to exit before binding; skip the extra graceful `control.shutdown`
    when `this.stopping` already sent it.
  - control_server.cpp idempotent check: compare `stable_key` against the running session's `cameraId` when provided.
- Handoff to human (if any): Windows C++ compile only in CI.

## Verification
- [x] Lint passed: `npm run lint` → exit 0.
- [x] Root Jest passed: `npm run test:jest` → 173 suites passed, 1949 tests passed.
- [x] Full build passed: `npm run build` → exit 0; includes root Jest, release-contract tests, protocol, bridge, graphics-renderer, and app build.
- [x] Native helper build passed: `npm run build:meeting-helper` → exit 0; all CMake targets built, wrapper completed after local ad-hoc signing fallback because Developer ID timestamping was unavailable (`A timestamp was expected but was not found.`).
- [x] Native raw-frame socket test passed directly: `apps/bridge/native/meeting-helper/build/raw_frame_server_test` → exit 0, `raw_frame_server_test passed`.
- [ ] Native helper tests: `npm run test:meeting-helper-native` → 11/12 CTests passed including `raw_frame_server_test`; only `meeting_recorder_writer_test` failed with `audio_input_rejected`, matching the documented local mic-permission/environment issue. The recorder writer sources/tests were not changed in this round, so the failure is not caused by the fixes.
- [x] Browser-verified (if UI-affecting) — n/a.
