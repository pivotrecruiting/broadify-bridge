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
- Round: 0/3
- Verdict: (pending)

## Verification
- [ ] Tests pass
- [ ] Windows CI compile + keyer-tier selftest
