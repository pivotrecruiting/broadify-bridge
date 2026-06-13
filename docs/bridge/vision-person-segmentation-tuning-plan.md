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
- Vision mask upscaling now uses bilinear alpha sampling instead of
  nearest-neighbor sampling.
- Alpha postprocessing adds configurable feathering after dilation to soften
  hard mask edges.
- Dilation is configurable through `mask_dilate_px` and can increase
  conservatively when the last visible mask age is high.
- Temporal alpha decay reduces one-frame foreground dropouts while dropping old
  foreground pixels quickly enough to avoid visible motion trails.
- `keyer.get` exposes the active tuning settings and additional metrics:
  `mask_width`, `mask_height`, and `mask_postprocess_ms`.

## Configuration

`keyer.configure` accepts the following optional fields:

- `quality_mode`: `"fast" | "balanced" | "accurate"`; default is `balanced`.
- `mask_dilate_px`: integer clamped to `0..8`; default is `1`.
- `mask_feather_px`: integer clamped to `0..3`; default is `1`.
- `dynamic_dilation`: boolean; default is `true`.

The defaults now prefer a thinner live edge. Dynamic dilation adds only a small
temporary safety margin when mask age is high.

Temporal stabilization uses a 250ms reuse window and a 64 alpha decay step, so
brief mask dropouts are softened without changing the current frame cadence.

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
