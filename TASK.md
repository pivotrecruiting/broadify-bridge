# TASK — WP4b: service-owned VCam shared-memory ring (Windows)

Base: feature/vcam-rc13 @ 4f628e95 (rc.28). Round: 3/3 — PASS.

## Field evidence (rc.28 vcam.log, 22.08.2026)
`session=0 user=LOCAL_SERVICE` … `vcam_reader_transport tcp reason=control_mapping_absent` … `stream_type subtype=RGB32 buffer=memory`.
The helper (unelevated user process) cannot create `Global\` mappings (needs SeCreateGlobalPrivilege) → demotes to TCP → the DLL (Frame
Server svchost, LOCAL SERVICE, Session 0, HAS the privilege) never finds a control mapping. SHM has never been active in the field.

## Design (implement exactly; Windows-only, macOS byte-for-byte unchanged)
Ownership flips: the DLL CREATES the `Global\` mappings, the helper OPENS them.
1. DLL (`vcam-helper/windows/shm_frame_reader.cpp`, new creator role):
   - On `MediaStream::Start()` (stream activation) create `Global\BroadifyVcam-control` + `Global\BroadifyVcam-stream` (+ event) with
     the maximum supported size (1920x1080 BGRA × existing slot count, from `vcam_shm_layout`), via `CreateFileMappingW` with SDDL:
     LS full; Interactive users (`IU`) + Authenticated Users (`AU`) read+write (`GRGW` / `GWGR`), no others. Zero-init; write
     `RingHeader.magic/version`, `layout_owner=service`, `writer_generation=0`, geometry 0 (= "no writer yet").
   - If creation fails (ERROR_ALREADY_EXISTS from a previous instance is OK → open existing; other errors → log reason, keep TCP path).
   - Keep the existing reader logic unchanged (seqlock copy, heartbeat staleness, 2 s no-frame → TCP, generation reset). Close mappings on
     `Stop()`/`Shutdown()` (handle release; the helper's open handle may keep the section alive — fine, generation handles restarts).
   - Log once: `vcam_shm_owner service created` / `opened_existing` / `create_failed error=<n>`.
2. Helper (`meeting-helper/src/preview/vcam_shm_ring_win.{h,cpp}`, `control_server.cpp`, `frame_pipeline.cpp`):
   - New order on `output.vcam.raw.start` (transport shm): (a) `OpenFileMappingW(FILE_MAP_WRITE)` on the `Global\` control+stream
     mappings → `reason=opened_service_ring`; (b) else try create `Global\` as today (works when elevated) → `created_global`;
     (c) else `Local\` is NOT useful across sessions → do NOT create it; stay on transport tcp with `reason=service_ring_absent`
     and RETRY (a) every 2 s while raw output is armed (the DLL creates the ring only when Teams activates the camera, i.e. after us).
     On successful late open: switch publishing to shm, bump `writer_generation`, emit `meeting_vcam_shm` event `transport=shm`.
   - Helper validates magic/version/capacity on open; writes geometry + generation; publishes as today. If the DLL recreates the ring
     (new section), the helper's handle points at the old one: detect via reader heartbeat absence >5 s → close and re-run (a).
   - Keep TCP server running regardless (DLL falls back on it; also the preview path).
3. Layout (`vcam_shm_layout.{h,cpp}`): add `owner` + `capacity_bytes` fields to `RingHeader`/`ControlRecord` (version bump), validation
   helpers `validateServiceRing(...)`, name helpers unchanged. Both sides share this file (already compiled into the DLL).
4. Tests: ctest `vcam_shm_service_ring_test` (Windows-only): creator initialises → helper-side open/validate → publish → reader copy; wrong
   magic/capacity rejected; retry state machine unit test (platform-neutral, pure logic) for the helper's (a)/(b)/(c)+retry sequencing.
   Extend `--vcam-shm-selftest` to run creator-then-open in-process (Local\ namespace for the test, flag `--namespace local`).
5. Docs: `docs/bridge/features/virtual-camera-windows.md` — ownership, privilege reality, DACL, reasons table
   (`opened_service_ring|created_global|service_ring_absent|global_namespace_privilege`), field checklist (what vcam.log + helper events
   should show). `docs/bridge/architecture/meeting-windows-stage-b-design.md` WP4b section.
6. Security: DACL is local-only; document that any local authenticated user could write frames into the ring (accepted; same trust
   level as the TCP loopback port today). No secrets. Validate every header field from the other side before use (sizes, offsets).

## Acceptance
- macOS unchanged (git diff shows only `_WIN32` code / Windows-only files / docs).
- `npm run lint`, `npm run test:jest`, `npm run build`, `npm run build:meeting-helper`, `npm run test:meeting-helper-native` green
  (recorder `audio_input_rejected` known).
- Windows CI (test-release/wp4b-service-ring) green incl. SHM selftest.
- Field: vcam.log shows `vcam_shm_owner service created` + `vcam_reader_transport shm`; helper event `transport=shm reason=opened_service_ring`.

## Review round 1 (HEAD d73e39a7; verifier green on macOS) — MUST-FIX
- R1-1 Win compile break: `main.cpp:744` calls `initialVcamWriterGeneration()` defined only in an anonymous namespace in
  `control_server.cpp:33`. Move to a shared header (`preview/vcam_writer_generation.h`) with one definition.
- R1-2 `created_global` ring (elevated helper) is rejected by the DLL: `createWithNamespace` sizes `ringBytesFor(w,h)` and writes
  `capacity_bytes=ringBytes_`, but DLL validators require `capacity_bytes >= maxServiceRingBytes()`. Allocate `maxServiceRingBytes()` for
  the Global ring (geometry-sized only for the Local\ test path) — and add a test running the DLL-side validator on the helper-created ring.
- R1-3 Race: `openServiceRing`/`createWithNamespace` assign handles/memory and call `initializeRing`/`publishControl` without `mutex_`, while
  `raw.stop` → `close()` and the lifecycle thread (`main.cpp:757`) run concurrently → null write at `openServiceRing:421`, double CloseHandle.
  Fix: the lifecycle thread is the SOLE owner of open/retry/close (raw.start/stop only flip an "armed" flag + wake it); `create()` builds into
  locals and commits under `mutex_`; `active()` read under the lock or atomic.
- R1-4 Security OOB: `validHeader` must require `slot_stride == slotStrideFor(width,height,format)` AND
  `headerBytes + slot_count*slot_stride <= bytes`; `copyNewestFrame`/`publishFrame` must check `size == expected` and slot bounds before memcpy.
  Every field read from the mapping is untrusted (AU can write). Add negative tests (bad stride, bad slot_count, bad offsets).
- R1-5 Tests don't exercise the production path: give `openServiceRing` a namespace parameter (Local\ in tests); new ctest chain:
  DLL-style `initializeServiceRing` + zero-geometry control record → helper `openServiceRing` → publish → reader `copyNewestFrame` →
  `validateServiceControl/validateServiceRing` pass (this would have caught R1-2). Use `decideVcamShmRetry` in `main.cpp` (or delete it) so
  `vcam_shm_retry_state_test` tests real code. CI ps1: also run `--vcam-shm-selftest --namespace local`.
Notes to fold in (no extra round): N-1 treat zero-geometry open as "not open" for `hasMapping()`/heartbeat so TCP starts immediately and
the 2-s no-frame rule applies; N-3 start the helper's 5-s reader-absent timer only after a reader was seen once; no 25-MB memset on
heartbeat-only re-init; N-4 emit `vcam_transport_selected transport=tcp reason=…` from the lifecycle thread on failed retry / absent close;
N-6 log `vcam_shm_owner` once per outcome change; N-7 any magic/version/owner/capacity-valid header is openable (helper overwrites the rest);
N-8 architecture doc: describe the real mechanism (section kept alive by open handles, generation bump); N-12 reasons table add
`invalid_service_ring`, `create_failed`; doc the AU write consequence (arbitrary object names → read-only, size-validated).

## Review round 2 (HEAD dff604af; verifier green) — R1-1..R1-5 verified PASS. MUST-FIX:
- R2-1 SDDL `D:P(A;;GA;;;LS)(A;;GRGW;;;IU)(A;;GRGW;;;AU)` lacks GX → for the EVENT, SYNCHRONIZE lives in GENERIC_EXECUTE → same-user reader
  (`--vcam-shm-selftest` Global in CI, `main.cpp:392 OpenEventW(SYNCHRONIZE)`) gets ACCESS_DENIED at stage `reader_open`. Add `GX` for
  IU/AU (`GRGWGX`), update `testNamesAndSddl` + DACL sentences in both docs.
Notes to fold in: N2-1 clamp `ProbeGeometry` width/height via `validateServiceControl` (+ max 1920x1080) before use in media_source;
N2-2 `createWithNamespace` always allocates `maxServiceRingBytes()` so the Local test path equals production and the test asserts the DLL
validators on the helper-created ring; N2-4 emit `vcam_transport_selected transport=tcp reason=…` only on reason change (retry stays silent);
N2-5 `initializeRing` memsets only header + slot headers; N2-6 in `createWithNamespace` write `header->owner=Service` BEFORE publishing the
control record; N2-7 DLL control-record write: fields first, `sequence` last with release fence; N2-13 docs: SHM engages ≤ ~7 s after Teams
activation (DLL 5-s poll + helper 2-s retry), the first `control_mapping_absent` line is expected.

## Review round 3 (HEAD d79d720e) — PASS. Notes only: N3-1 theoretical one-frame garbage window during in-place re-init with geometry
change (zero slot headers before writing stride/magic), N3-2 GX also on the section (inert), N3-3 reason-string wording. Verifier green.
