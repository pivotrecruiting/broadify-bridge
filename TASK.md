# Task: WP5 — Temporal segmentation tiers + keyer tuning (Stufe B-3)

## Raw request
User 22.08.2026 after rc.26 field test: "Teams-Kamera geht jetzt. Keyer ist besser. Windows noch etwas laut und Keyer muss noch besser
eingestellt werden. Aber erstmal WP4 und 5." → WP5 = make keying temporally stable by design (not by post-filters) and give the keyer a
clean tuning surface. Loudness is WP3's job (after WP5).

## Context
- Worktree / branch: `broadify-bridge-worktrees/win-stability-wp5` / `feature/win-stability-wp5`, base `feature/win-stability-wp4`
  (= rc.26 fixes + WP4 shared-memory transport). Host macOS; Windows only in CI (`test-release/wp5-temporal`).
- Official facts (analysis report §06): MODNet has no temporal state; its authors' flicker remedy is OFD (one-frame delay, a 3-frame
  median-like fix that needs the NEXT frame → +1 frame latency). Windows Studio Effects exposes an OS background-segmentation mask
  (`KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION` + per-frame `MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK`) on NPU devices
  with the built-in camera; Microsoft recommends consuming it and setting our own effects OFF otherwise. RVM (temporal, GPL-3.0) is
  EXCLUDED until the user decides on the licence — keep the backend interface pluggable so it can be added.
- macOS untouched (CoreML path); all Windows-only.

## Plan (one commit per block)

### Block A — Tier selection + OS mask (T0)
A1. `keyer/segmentation_tier.{h,cpp}` (platform-neutral decision, Windows probes): tiers `os_mask` (T0), `modnet_512_ofd` (T2),
    `modnet_320_ofd`, `selfie_landscape` (T3, only if the model asset exists). Selection at camera start by a probe:
    - T0 if the capture source advertises `KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION` with the `_MASK` capability
      (query via `IKsControl` on the source / `IMFExtendedCameraController` → `IMFExtendedCameraControl`, KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION);
      enable `_MASK`, read `MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK` from each sample's `MFSampleExtension_CaptureMetadata`
      (IMFAttributes blob → `KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK`), map the mask into our `AlphaMask` (MaskResolution,
      ForegroundBoundingBox → crop/scale into the frame). If the property exists but `_MASK` is unsupported, set `_OFF` (no double
      effects) and continue with T2. Log `segmentation_tier_selected {tier, reason}`; status `keyer_tier`.
    - Env override `BROADIFY_MEETING_KEYER_TIER=auto|os_mask|modnet_512_ofd|modnet_320_ofd|selfie_landscape`.
A2. Persist the probe result per machine (`<userData>/keyer-tier.json` via a helper event the bridge stores) so subsequent starts skip
    the probe; invalidated on camera change.

### Block B — MODNet OFD (T2) and fixed input (no governor jo-jo)
B1. `pipeline/ofd_temporal.{h,cpp}` (platform-neutral, ctest): One-Frame-Delay per the MODNet authors — keep α(t-1), α(t), α(t+1);
    for each pixel if |α(t-1) − α(t+1)| < ε_near and |α(t) − α(t-1)| > ε_far and |α(t) − α(t+1)| > ε_far, replace α(t) by the mean of
    α(t-1) and α(t+1). Output is delayed by one frame; the pipeline pairs the delayed mask with the frame it belongs to (the compositor
    composites frame t when α(t) is final) — i.e. the program output lags the camera by one frame (33 ms). Env
    `BROADIFY_MEETING_KEYER_OFD=1|0` (default 1 on Windows when tier is modnet_*).
B2. Fixed input per tier for the session: the governor no longer changes the fused input size at runtime; it may only (a) engage the
    cadence pin/unpin and (b) switch to the explicit lower tier after ≥ 30 s of over-budget (hysteresis 60 s up). Remove the
    per-frame tier oscillation paths; keep the async Lite path only as a fallback when even 320 cannot hold 30 fps.
B3. With OFD in place, disable the fused EMA by default on Windows (`BROADIFY_MEETING_FUSED_EMA_STATIC` default 1.0 = off) — the
    temporal fix must not be double-applied; keep the edge-stabilization off on fused; document.

### Block C — Selfie landscape model (T3, iGPU-only machines)
C1. Asset pipeline: `scripts/prepare-selfie-segmenter-model.sh` converts the official MediaPipe SelfieSegmenter landscape (144×256,
    Apache 2.0) TFLite to ONNX (tf2onnx or onnx2tf — document the exact command and the licence/attribution in
    `apps/bridge/native/meeting-helper/models/THIRD_PARTY.md`); `models/manifest.json` entry with sha256; download/cache like MODNet
    in CI (`release.yml`/`test-release.yml`), packaged via `extraResources`.
C2. `keyer/selfie_keyer.{h,cpp}`: ORT DirectML backend for the 144×256 model (input RGB 0..1, output mask 0..1), letterbox mapping,
    output upsampled to 512×288 work grid; integrated into `MattingBackend` factory as tier `selfie_landscape`.
C3. Selection rule: when the machine has no discrete GPU (adapter policy reports iGPU only) AND modnet_320 probe > budget → T3.

### Block D — Tuning surface
D1. Single `KeyerTuning` struct (Windows): guided radius/eps, coefficient EMA, erode/dilate/feather, OFD epsilons, edge-stab, cadence
    pin, tier; loaded from env + webapp `keyer.configure`; exposed in `keyer.get` as `tuning` (effective values) with `source`
    (default/env/webapp). Presets: `balanced` (default), `sharp` (less feather, lower eps), `soft` (more feather, higher eps), selectable
    via `BROADIFY_MEETING_KEYER_PRESET` and `keyer.configure {preset}`. No new webapp UI in this WP (bridge contract only; document the
    field for the webapp team).
D2. Field A/B doc: `docs/bridge/features/meeting-keyer-windows.md` "Tuning" section with the preset table and the env knobs.

### Block E — Tests, selftest, docs
E1. ctests: OFD on synthetic flicker sequences (flicker removed, motion preserved, one-frame delay), tier decision table, tuning
    resolution (env/webapp/preset precedence), OS-mask blob → AlphaMask mapping on a synthetic `KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK`.
E2. Windows smoke: `meeting-helper --keyer-tier-selftest` prints the probe result on the CI runner (expected: no OS mask, T2 chosen).
E3. Docs + design doc status; runbook: what `keyer_tier` means in field logs.

## Acceptance criteria
1. Tier selection logged + in status; env override works; OS mask consumed when available, `_OFF` set otherwise (review + ctest of mapping).
2. OFD ctest: synthetic single-frame flicker removed, genuine 2-frame motion preserved; program output delayed by exactly one frame.
3. No runtime fused input-size oscillation (governor test: tier change only after the hysteresis windows).
4. Selfie model asset documented, hashed, packaged; keyer runs through the backend factory (ctest with `BROADIFY_ENABLE_MODNET=0` stub
   path; real inference verified in CI smoke when the asset is present).
5. `keyer.get.tuning` reflects effective values + source; presets switch; ctest.
6. macOS untouched; lint/jest/build/helper/ctests green; Windows CI test branch green before any RC.

## Review
- Round: 1/3
- Verdict: MUST-FIX (round 1) — real: OFD algorithm, tier decision table, lite-gate timer, status/log plumbing. Stub/disconnected:
  OS-mask probe/enable/consume, selfie backend, tier→pipeline wiring, tuning→pipeline wiring, governor 512/320 gating; macOS
  regression; docs deleted. Rule: a real path or the feature is removed from the shipped surface — never a stub reported as a feature.
- Must-fix (open):
  - M1 OS mask (A1) real path: `windows_os_mask.cpp` — obtain the `IMFMediaSource` from the MF capture session →
    `MFCreateExtendedCameraController` / `IMFExtendedCameraController::GetExtendedCameraControl(MF_CAPTURE_ENGINE_MEDIASOURCE,
    KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION, &ctrl)`; `GetCapabilities()` & `KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK`;
    `SetFlags(_MASK)` + `CommitSettings()` else `SetFlags(_OFF)` + commit; in the sample callback
    `IMFSample::GetUnknown(MFSampleExtension_CaptureMetadata, IID_IMFAttributes)` → `GetBlob(MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK)`
    → parse `KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK` honouring `MaskCoverageBoundingBox` (frame region the mask covers),
    `MaskResolution`, `ForegroundBoundingBox` (outside = background) → `AlphaMask` aligned to the frame; when tier == os_mask the fused
    path uses that mask and skips `fusedKeyer->apply`. Fix the mapping test geometry to the KS struct semantics.
  - M2 OFD vs cadence (B1): on cadence-skip frames composite the OFD-delayed frame (push `latestCameraFrame` into the OFD frame queue and
    composite `front()`), never frame t with mask t-1; `lastFusedInferredTsNs` = the delayed frame's ts; prime the first two frames
    sensibly (document). Construct `fusedOfd` from `state.keyerTuning.ofdEpsilon*` (not defaults). Keep frames by shared_ptr (no 8 MB copies).
  - M3 governor (B2): gate ALL fused step-downs (512→320→256) behind the 30 s over-budget clock, 60 s step-up dwell; test "512 does not
    step to 320 before 30 s"; pass the tier DECISION (not env) into the fixed performance mode for `modnet_320_ofd`.
  - M4 (B3) `fusedEmaMotion` default 1.0 on Windows (EMA fully off when OFD active).
  - M5 Selfie backend (C2) real: `Ort::Session` via the existing DML policy, NHWC 1×144×256×3 float RGB 0..1 (or NCHW if converted
    with `--inputs-as-nchw`), letterbox, output activation per model, upsample to the 512×288 work grid; fail-soft: asset absent →
    tier unavailable → MODNet (never "no keyer"). C1 script: default to the official `selfie_segmenter_landscape.tflite` URL
    (mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/), sha256 verification, document input/output names;
    manifest gets a real sha256 once converted — until then the asset is marked optional and CI skips it explicitly (logged).
  - M6 Probe population (C3/A1): `integratedGpuOnly` from the adapter-select policy; `modnet320ProbeMs` from the existing probe; auto
    decision wired into `MattingBackendOptions.segmentationTier`.
  - M7 macOS regression (D1): guard `main.cpp` tuning application with `#if defined(_WIN32)`; `KeyerTuning` defaults == prior
    `MeetingState` defaults on non-Windows; verify macOS postprocess settings byte-for-byte.
  - M8 Tuning drives the pipeline (D1): guided radius/eps/coefficient EMA read from `state.keyerTuning` (remove the env reads, env goes
    through the tuning resolver), OFD epsilons likewise; reported defaults == effective defaults; `applyKeyerTuningPatch` is a real patch
    with precedence default < env < webapp; tests.
  - M9 Bridge contract (D1): `preset: z.enum(["balanced","sharp","soft"]).optional()` in `MeetingKeyerConfigureSchema` + test; client forwards.
  - M10 Docs (D2): restore the deleted sections of `meeting-keyer-windows.md` and ADD the Tuning/Field-Logs sections.
  - M11 Selftest (E2): wire `--keyer-tier-selftest` into the Windows smoke script; cache file: read it on start or rename the event.
- Notes: `THIRD_PARTY.md` source URL + version; `keyer_tier_cache` single event; include `<string>` directly.

## Verification
- [ ] Tests pass
- [ ] Windows CI compile + keyer-tier selftest

### WP5 review round 2 — MUST-FIX (M3/M5/M7/M9 resolved)
- R2-1 (M1) tier decision timing: run `decideSegmentationTier` AFTER the camera source is attached (on `camera.start` success, and again
  on camera change), not at process start; publish `keyer_tier` + `segmentation_tier_selected` then; `BROADIFY_MEETING_KEYER_TIER=os_mask`
  honoured once the probe succeeded. When tier == os_mask and a sample carries NO mask blob → use MODNet for that frame (never un-keyed).
  `--keyer-tier-selftest` opens the first camera (if any) before deciding; reports `no_camera` honestly otherwise.
- R2-2 (M2) cadence-skip frames: composite the advancing OFD queue front (the frame whose mask is final), never `lastFusedRawFrame`
  again; hold frames by `shared_ptr` taken from the capture path (no `make_shared<VideoFrame>(copy)` per inference frame — add a
  `copyLatestFrameShared()` or move semantics); document the two-frame priming in a comment.
- R2-3 (M4) `fusedEmaMotion` default 1.0 on Windows (EMA fully off when OFD is active); keep macOS value.
- R2-4 (M6) `modnet320ProbeMs` from the existing tier probe (the 320 session warm-up measurement already taken at first load), not env;
  therefore the auto decision may be refined after first load (re-decide once, log).
- R2-5 (M8) D3D11 guided refine (`d3d11_compositor.cpp` ~:991-998) reads radius/eps/coeffEma from `state.keyerTuning` (pass a
  `GuidedTuning` struct into the call), remove its private env reads; `coefficientEma` and `cadencePinEnabled` consumed; Windows
  default epsilon stays 5e-4 (do not silently change defaults — `KeyerTuning` defaults must equal rc.26 effective values);
  `applyKeyerTuningPatch` = real patch (only provided fields), precedence default < env < webapp with a ctest asserting each layer.
- R2-6 (M10) restore the deleted sections of `meeting-keyer-windows.md` (Pipeline, Environment table, Field A/B, Status And Logs, Teams
  Grey Triage) from git history (`git show 789a1965:docs/bridge/features/meeting-keyer-windows.md`) and keep the new sections; fix the
  "falls back to MODNet" wording to what the code does.
- R2-7 (M11) remove the duplicate `keyer_tier_cache` event (or read the cache on start to skip the probe — one or the other).
- Notes: `adapterLooksIntegrated` log field; async worker ignores tier (document as known limitation).

## HANDOFF — WP5 stopped after review round 3/3 (22.08.2026), HEAD 7c6b5f55
Verifier: lint/jest(1951)/build/helper build/ctest 28/28 green on macOS. Round 3 verdict: MUST-FIX → STOP per doctrine (no round 4).
Resolved in rounds 1–2: R2-1 tier decision after camera attach (never un-keyed), R2-3 EMA off on Windows, R2-5 tuning precedence +
D3D11 guided refine driven by KeyerTuning, R2-6 docs, R2-7 cache event. macOS behaviour unchanged.
Open MUST-FIX for the next owner:
- H1 Windows compile break: `frame_pipeline.cpp:524` calls `d3dAdapterPolicyIsIntegratedGpuOnly()` without `#include "compose/d3d_adapter_select.h"`
  (add under the `_WIN32` include group). CI run 32581919324 on test-release/wp5-temporal is the proof.
- H2 Tier refinement (R2-4) cannot switch to `selfie_landscape`: the fused keyer is a `static const unique_ptr` created once with the initial
  tier (`frame_pipeline.cpp:2709`), `createMattingKeyer` picks the model at construction. Status/event claim selfie while MODNet runs.
  Fix: recreate/hand over the fused keyer on tier change, or restrict refinement to the 320 tier and report honestly.
- H3 Cadence-skip ticks repeat the previous frame (`frame_pipeline.cpp:3221-3231`, `lastFusedOfdFrame` only advances per inference) →
  15 fps at N=2, freeze for N-1 ticks at N=3/4; rc.26 composited `latestCameraFrame` on skip ticks. Fix: camera-frame-indexed delay
  queue; composite the popped t-1 frame on skip ticks with the reused mask.
Notes: N1 double frame copy (hold shared_ptr only); N2 KeyerTuning defaults dilate/feather/edgeStab/strength differ from rc.26
(1/1/false/0.25 vs 0/0/true/0.35) — product decision; N4 CPU guided eps atomic default 2000u→500u; N5 clamp webapp guided_epsilon ≥1e-6;
N7 guided_enabled log prints radius 8 not effective 4; stale `keyer_tier_cache` mention in meeting-windows-stage-b-design.md:64.
Do NOT merge WP5 into an RC until H1–H3 are fixed and re-reviewed.
- H1 (CI proof, run 32581919324 on 7c6b5f55): `error C3861: 'd3dAdapterPolicyIsIntegratedGpuOnly': identifier not found` AND
  `error C2039: 'copyLatestFrameSharedIfNew': is not a member of 'MfCaptureSession'` (camera_mediafoundation.cpp — the method is called on
  the anonymous-namespace MfCaptureSession but only declared/defined elsewhere; declare it in the class or call through the owning source).
