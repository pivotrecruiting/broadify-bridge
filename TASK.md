# TASK — WP7 (rc.32a): ghost-free 1080p capture on Windows, stage 1 (pure logic, no GPU code)

Base: feature/vcam-rc13 @ 8ae984ec (rc.31). Round: 2/3 — PASS.
Requirement (user): camera stays 1920x1080 on EVERY machine; ghost must go; nothing that works today may regress.
Field diagnosis (rc.31 on GTX 1660 Ti laptop): ranker picks MJPG 1080p30 (raw only ≤720) → MF software MJPEG decode on the MF thread (~1 core)
+ render-thread costs scale 2.25x (8.3-MB `copyLatestFrameIfNew` under frameMutex_, scalar MODNet pre-pass, 8.3-MB UpdateSubresource);
governor/cadence see only `sessionRunMs` (frame_pipeline.cpp:644-649, 3064-3069) → CPU overrun invisible → pacing clamp drops frames
(frame_pipeline_gating.cpp:40-51) → stale/ghost. Stage 2 (rc.32b) = GPU pre-pass + MJPEG HW experiment; NOT in this WP.

## A1 — Zero-copy camera hand-off (Windows only)
- `capture/camera_mediafoundation.cpp`: `MfReaderCallback` gets a member `VideoFrame scratch_`; `processSample` swizzles into
  `scratch_.rgba` (resize = no-op at steady size → no per-capture allocation; today: local `VideoFrame frame` ~:699 + `swizzleBgraToRgba`
  resize on a fresh vector, pixel_swizzle.cpp:103-113), sets width/height/timestamps, then under `frameMutex_`: `std::swap(scratch_,
  latestFrame_); hasFrame_ = true;`.
- New `bool takeLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame)` on `MfReaderCallback`, `MfCaptureSession`,
  `MediaFoundationCameraSource`: under `frameMutex_`, same predicate as `copyLatestFrameIfNew` (~:442-449), then `std::swap(frame,
  latestFrame_)` → the consumer's previous buffer (timestamp == lastTimestampNs) now sits in `latestFrame_`, so `waitForFrameOrTimeout`
  predicates (~:454-456) stay correct with no extra state. Three buffers rotate: scratch / latest / consumer. O(1) under the lock.
- `capture/camera_source.h`: declare the virtual ONLY inside `#if defined(_WIN32)` (default: forwards to `copyLatestFrameIfNew`) — no
  vtable change on macOS. Call site `pipeline/frame_pipeline.cpp:~1924` under `#if defined(_WIN32)`; Apple path literally untouched.
- Keep `copyLatestFrame`/`copyLatestFrameIfNew` unchanged (PiP reads a different session ~:1998-2002; conference programIndex_ switch only
  moves the pointer). `camera stop` path (`latestCameraFrame = VideoFrame{}` ~:1941) unchanged.
- Extract the slot logic into a pure, testable class `capture/latest_frame_slot.h` (`publish(VideoFrame&&)`, `takeIfNew(lastTs, frame)`,
  `copyIfNew`, `hasFrame`), used by `MfReaderCallback`. ctest `latest_frame_slot_test`: take returns true once per timestamp; buffer
  capacity reused (pointer identity across 3 rotations, zero allocations after warm-up); second take same ts → false; wait-predicate parity.
- Field: `keyer.get.metrics.camera_copy_ms` ≤ 0.1 at 1080p (was ≥1.5).

## A2 — Governor/cadence see the real frame budget (tier step, never camera resolution)
- Do NOT feed overhead into `addSample` (step-up estimate scales by input area, keyer_governor.cpp:79-84; overhead > budget would march
  the ladder to Off). Add `void setFrameOverheadMs(double)` to `KeyerAutoGovernor`: `stepDownThresholdMs()` (~:69-73) becomes
  `max(kOverheadFloorFactor(0.5) * base, base - overhead_)`; `stepUpThresholdMs()` derives from it (hysteresis coherent); override path
  `stepDownOverrideMs` unchanged. Same `setFrameOverheadMs` on `FusedCadenceController` reducing `budget` in `currentN()`
  (keyer_cadence.cpp:24-29) with the same floor.
- frame_pipeline.cpp (Windows fused branch): on frames where fused inference ran, after `programEnd` (~:3311) compute
  `overhead = programFrameMs - sessionRunMs`, EMA weight 0.2 into a loop-local `fusedOverheadEmaMs`; feed both controllers at the top of the
  fused branch (before `maybeStepUp`, ~:2635); reset with `fusedGovernor.reset()` (~:3155-3156). One-frame lag acceptable.
- Anti-flap: existing `minSamples`, `stepUpHoldoff_` (10 s, doubling), `stepUpFactor 0.8`, `tierFirstPolicy` (30 consecutive) untouched;
  floor guarantees overhead alone never goes below Performance256 and never to Lite/Off.
- Update the comment at :644-649 (tiering still driven by session cost; the BUDGET shrinks) — do not contradict it.
- ctest `keyer_governor_test` (new cases, existing cases UNCHANGED): (1) overhead 15 ms + samples 20 ms at Full512 → Balanced320 (today:
  stays); (2) then 8 ms samples → no step-up (8×2.56 > 0.8×18.3); (3) overhead 30 ms, samples 5 ms at Performance256 → stays (floor), never
  Lite; (4) override path unaffected. `keyer_cadence_test`: overhead 15 ms, ema 18 ms → N=2 (today N=1).

## A3 — Metrics + over-budget event
- `keyer/keyer.h` KeyerMetrics: `cameraUploadMs`, `frameOverheadMs`, `budgetThresholdMs`, `prepassGpu` (false for now). Upload timing
  around `UpdateSubresource` in `uploadCameraFrame` (compose/d3d11_compositor.cpp:588-602), exposed like `d3d11CompositorCameraUploadCount()`
  (~:731). TRAP: `keyer_chain.cpp:296-308` re-carries pipeline-owned fields explicitly — add every new field there (else −1 after inference).
- JSON keys `camera_upload_ms`, `frame_overhead_ms`, `budget_threshold_ms`, `prepass_gpu` in `keyerMetricsJson` (control_server.cpp:152-188)
  emitted under `#if defined(_WIN32)` → macOS `keyer.get` byte-identical.
- Helper events `keyer_budget_overrun {program_frame_ms, session_run_ms, tensor_ms, camera_copy_ms, camera_upload_ms, tier, cadence_n}` on
  entering overrun (EMA of program_frame_ms > budget for ≥30 frames), at most once per 10 s while persisting, and `keyer_budget_recovered`.
  Pure `BudgetOverrunReporter` class + ctest for the rate limit. NEVER per frame (WP6 R1-4 lesson).
- Docs: `meeting-windows-performance.md` (new section rc.32a), `meeting-field-checklist.md` rows: "Camera hand-off zero-copy"
  (camera_copy_ms ≤ 0.1), "Budget visible" (frame_overhead_ms/budget_threshold_ms present; overrun event followed by a tier step within 2 s).

## Parity / must NOT change
- macOS: no Apple hunk; `camera_source.h` vtable unchanged on macOS; `keyer.get` JSON identical; `matting_common.cpp` untouched.
- Ranker + 1080 default (rc.31 S1) unchanged; no capture-resolution fallback anywhere.
- Governor `addSample` inputs, `stepDownOverrideMs`, warm-handover, `tierFirstPolicy` unchanged; existing governor/cadence tests pass unmodified.
- Report must list every hunk in files compiled on macOS but Windows-executed only (keyer_governor.cpp, keyer_cadence.cpp, keyer.h, control_server.cpp).

## Acceptance
- lint/jest/build/helper build/ctest green (recorder audio_input_rejected known); Windows + macOS CI (test-release/wp7-budget) green.
- Field (1660 Ti, MJPG 1080p30, Teams): program_fps ≥ 29.5 over 10 min, keyer_pipeline_mode ∈ {fused, fused_cadence}, mask_age_ms ≤ 34,
  camera_copy_ms ≤ 0.1, program_frame_ms p95 ≤ 30; at most one keyer_budget_overrun per 10 s, each followed by a stage change/recovered.

## Review round 1 (HEAD b46900a0; verifier green; A1/A2 PASS) — MUST-FIX
- R1-1 `frame_pipeline.cpp:3375-3377`: `BudgetOverrunReporter::update(programFrameMs, budget = fusedBudgetThresholdMs)` — the threshold is
  already `base − overhead`, program frame ≈ session + overhead → overhead counted twice → permanent spurious `keyer_budget_overrun`
  (e.g. overhead 12, session 14 → frame 26 > 21.3 while governor correctly does not step). Fix: compare against the REAL frame budget
  (`stepDownFactor × frameBudgetMs`, i.e. the governor base before overhead subtraction; or `threshold + overheadEma`), never the reduced
  threshold; keep `budget_threshold_ms` metric as is. Test: overhead 12 / session 14 @30 fps → no event; session 30 → event.
Notes to fold in: N1 apply the 10-s repeat interval also to re-entry after Recovered; N4 skip the first overhead sample (or seed with 0);
N5 fix the re-indentation in keyer_governor_test.cpp:306 / keyer_cadence_test.cpp:127-128; N3 comment that camera_upload_ms is "last upload";
N7 make reporter/EMA loop-locals; N6 comment on LatestFrameSlot::copy() semantics after take.

## Review round 2 (HEAD f59cdfa6) — PASS. Notes: reporter budget = 1000/fps (stepDownFactor is 1.0 everywhere today); MAX_INFERENCE_MS-Override → wiederkehrende Overrun-Events by design; N7 statics stilistisch; latest_frame_slot.h copy()-Kommentar nach take ungenau (kein Live-Caller); kein Test am Call-Site-Budget. Verifier grün.
