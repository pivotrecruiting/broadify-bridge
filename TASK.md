# TASK — WP4c: VCam SHM publish off the render thread (Windows)

Base: feature/vcam-rc13 @ f1acb5e8 (rc.29). Round: 1/3.

## Field evidence (rc.29, 22.08.2026)
SHM path active for the first time (vcam.log: `vcam_shm_owner service created` → `vcam_reader_transport shm reason=shm_frame_available`),
laptop quieter, BUT keyer ghost+latency and background changes stall. Root cause (read-only analysis): `frame_pipeline.cpp:3202-3210`
runs swizzle RGBA→BGRA + 8.3 MB memcpy into the ring + SetEvent synchronously on the render thread on every program tick (unreachable in
rc.28 where transport was demoted to tcp), while `vcamClients>0` (now fed by the SHM reader slot) forces every-frame fused inference.
Pacing (`frame_pipeline_gating.cpp:40-51`) drops late frames → mask age grows → ghost/latency; `programDirty` (background change, image
decode on the same thread) is serviced late. `previewFrames.publish` (another 8.3 MB copy, `:3195-3199`) still runs although nobody reads it
on the SHM path. The Frame Server reader copies on every SetEvent AND again in RequestSample (`shm_frame_reader.cpp:575-580`,
`media_stream.cpp:516`). No locks/deadlocks involved.

## Design (implement exactly; Windows-only; macOS byte-for-byte unchanged; keyer tuning/cadence/policy untouched)
- SP-1 Publisher thread (helper): new `VcamShmPublisher` (preview/vcam_shm_publisher.{h,cpp}, `_WIN32` only) owning a double buffer of
  RGBA program frames (latest-wins: render thread does ONE memcpy into the free slot under a tiny mutex — or better, swaps a pre-allocated
  buffer pointer — and notifies a condition variable; if the publisher is busy the older pending frame is dropped). The publisher thread
  swizzles + publishes via `VcamShmRingWin` and maintains a `dropped_frames` counter exposed in `keyer.get` metrics
  (`vcam_publish_dropped`, `vcam_publish_ms`). Lifecycle: started by the lifecycle thread when the ring opens, stopped on close/shutdown;
  join on exit. No work when `!vcamShm->active()` (render thread must not even swizzle then).
- SP-2 One-pass swizzle into the slot: `VcamShmRingWin::publishRgbaAsBgra(width,height,rgba,stride,…)` that runs the AVX2/SSE2 swizzle
  (`util/pixel_swizzle.cpp`) with the ring slot as destination (no intermediate `vcamBgraFrame`). Seqlock protocol unchanged.
- SP-3 Skip the dead copy: split `vcamClients` into TCP raw clients vs SHM readers in `PipelineRuntimeState`; `previewFrames.publish` only
  when a TCP raw client or MJPEG preview client exists. The keyer policy input (`vcamClients>0` → force-every-frame/paired frame) must keep
  the SAME value as today (tcp OR shm reader) — do not change cadence/policy in this WP.
- SP-4 DLL reader: copy the newest ring frame only in `RequestSample` (MF cadence), not on every event; the event wait just wakes to check
  staleness/generation. Keep 2-s no-frame and heartbeat logic.
- SP-5 Tests: ctest for the publisher (latest-wins drop semantics, stop/join, no publish when inactive); ctest for in-slot swizzle
  correctness vs the two-pass path (byte-equal); `keyer.get` metrics fields present. macOS: compile-neutral (files under `if(WIN32)`).
- SP-6 Docs: `docs/bridge/features/virtual-camera-windows.md` + `meeting-windows-performance.md`: publish thread, metrics, why.

## Acceptance
- macOS unchanged; lint/jest/build/helper build/ctest green (recorder audio_input_rejected known); Windows CI green incl. SHM selftests.
- Field: keyer quality like rc.28 with Teams open, noise like rc.29, background change applies within ~1 s; `vcam_publish_dropped` ≈ 0.

## Review round 1 (HEAD 4232c9e0; verifier green) — MUST-FIX
- R1-1 `vcam_shm_publisher.cpp:60-63` `submitRgba()` calls `ring_->active()` (takes ring `mutex_`) while the publisher holds that mutex for
  the whole in-slot swizzle (`vcam_shm_ring_win.cpp:335-392`) → render thread blocks ~2-5 ms on contended ticks = the stall this WP removes.
  Fix: no ring lock on the render-thread path — drop `ring_->active()` from `submitRgba` (use `running_`, stop() always precedes close()) or
  an atomic "ring active" flag refreshed by the publisher thread. Convert the hand-off to a pointer/buffer SWAP (pre-allocated, no 8-MB
  memcpy under the publisher mutex; N-6) so the render thread only swaps + notifies. Add a test that injects the delay INSIDE the ring-locked
  publish and asserts `submitRgba` wall time stays bounded (<1 ms) and drops accumulate.
Notes to fold in: N-1 replace sleep-timing in the latest-wins test with a gating hook; N-3 one in-function retry on torn `copyNewestFrame`
in the DLL; N-4 `observeNewestLocked` checks `size == expected`; N-5 doc sentence that `published_preview_frames` stops with SHM-only readers;
N-2 publishMs -1 semantics documented or 0.
