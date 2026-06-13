# Vision Person Segmentation Tuning Plan

## Summary

The native meeting helper uses Apple's `VNGeneratePersonSegmentationRequest` for
the `vision_person_segmentation` keyer. The Vision model itself is a platform
black box, so the practical tuning surface is request quality, mask sampling,
alpha postprocessing, temporal tolerance, and observability.

This first pass keeps the current async keyer architecture and improves the
visible matte quality without changing the FrameBus or compositor contracts.

## Current State

- The Vision keyer receives an RGBA camera frame, wraps it as a `CGImage`, runs
  `VNGeneratePersonSegmentationRequest`, and copies the returned one-channel
  mask into the frame alpha channel.
- The keyer previously used a fixed Vision quality level and nearest-neighbor
  mask sampling.
- The pipeline previously applied a fixed 12px alpha dilation to every keyed
  frame before publishing the latest mask for the compositor.
- The compositor still uses the current RGB camera frame with the latest
  available alpha mask, so large motion can still expose mask age.

## Implemented Short-Term Wins

- `quality_mode` is configurable through `keyer.configure` with `fast`,
  `balanced`, and `accurate`; invalid values fall back to `balanced`.
- The Vision request and `VNSequenceRequestHandler` are reused across frames so
  the keyer runs on a sequence-oriented Vision path.
- Vision mask upscaling now uses bilinear alpha sampling instead of
  nearest-neighbor sampling.
- Alpha postprocessing is configurable, but the default live mode keeps the raw
  Vision matte without added dilation or feathering.
- Dilation is configurable through `mask_dilate_px`; a value of `0` means no
  dilation even when dynamic dilation is enabled.
- Temporal alpha stabilization is gated by a protection zone around the current
  mask, so old foreground is retained only near plausible current person pixels.
- `keyer.get` exposes the active tuning settings and additional metrics:
  `mask_width`, `mask_height`, and `mask_postprocess_ms`.

## Configuration

`keyer.configure` accepts the following optional fields:

- `quality_mode`: `"fast" | "balanced" | "accurate"`; default is `balanced`.
- `mask_dilate_px`: integer clamped to `0..8`; default is `0`.
- `mask_feather_px`: integer clamped to `0..3`; default is `0`.
- `dynamic_dilation`: boolean; default is `false`.

The defaults now prefer a raw matte with no artificial edge expansion. Any
remaining bright edge comes from the Vision matte itself or from background
pixels already included in the camera image.

Temporal stabilization uses a 250ms reuse window and a 64 alpha decay step, but
only inside a small protection zone around the current mask. When `mask_age_ms`
is above 140ms, retained alpha decays more aggressively to suppress trails.

## Measurement Criteria

- Compare `session_run_ms` across `fast`, `balanced`, and `accurate`.
- Track `mask_apply_ms` after bilinear sampling to confirm the CPU cost remains
  acceptable.
- Track `mask_postprocess_ms` for dilation and feathering cost.
- Track `mask_age_ms` and `dropped_frames` during movement to determine whether
  dynamic dilation is masking latency or creating visible halos.
- Inspect fast hand and shoulder movement for foreground loss, edge hardness,
  and halo width.

## Limits And Next Steps

These changes do not train or replace Apple's Vision model. They improve the
matte produced by the current platform API and make behavior measurable.

The next meaningful quality step is temporal stabilization:

- Smooth alpha over recent masks to reduce flicker.
- Motion-compensate the latest mask before applying it to the current RGB
  frame.
- Degrade to blur or passthrough when `mask_age_ms` exceeds a configured limit.
- Move toward a `CVPixelBuffer`/Metal path to reduce CPU copies.
