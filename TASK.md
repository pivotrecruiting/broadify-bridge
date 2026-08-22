# TASK — WP4b: service-owned VCam shared-memory ring (Windows)

Base: feature/vcam-rc13 @ 4f628e95 (rc.28). Round: 0/3.

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
