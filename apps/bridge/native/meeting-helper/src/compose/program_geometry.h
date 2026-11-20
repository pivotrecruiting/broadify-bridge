#pragma once

#include <algorithm>
#include <cstdint>

namespace broadify::meeting {

// Source-pixel -> canvas-pixel factor of the keyed presenter layer, before the
// speaker-layout scale. Uniform "height fit": the camera height fills the
// canvas height and the same factor applies to both axes, so the presenter is
// never squeezed and - being anchored at the bottom - never loses the head.
// - Camera and canvas share an aspect ratio: the former per-axis factor.
// - Camera wider than the canvas (1920x1080 on 1080x1920): the sides are
//   cropped around the speaker position.
// - Camera narrower than the canvas (640x480 on 1920x1080): the background
//   stays visible left and right of the camera picture.
inline double keyedPresenterHeightFitScale(uint32_t canvasHeight,
                                           uint32_t sourceHeight) {
  if (canvasHeight == 0u || sourceHeight == 0u) {
    return 1.0;
  }
  return static_cast<double>(canvasHeight) / static_cast<double>(sourceHeight);
}

// Placement of the conference camera picture-in-picture inset (bottom-right
// corner of the program frame).
struct CameraPipInsetGeometry {
  // False when the inset would not fit; nothing is drawn then.
  bool visible = false;
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t margin = 0;
  uint32_t border = 0;
};

// Inset width: 28% of the long canvas edge, capped at 45% of the canvas width
// so a portrait canvas does not lose half its width to the inset; the height
// follows the PiP camera's aspect ratio. Margin and border scale with the
// short edge. On a 16:9 canvas this is the former width-relative geometry
// (28% width, margin width/80, border width/480).
inline CameraPipInsetGeometry cameraPipInsetGeometry(uint32_t canvasWidth,
                                                     uint32_t canvasHeight,
                                                     uint32_t pipWidth,
                                                     uint32_t pipHeight) {
  CameraPipInsetGeometry geometry;
  if (canvasWidth == 0u || canvasHeight == 0u || pipWidth == 0u ||
      pipHeight == 0u) {
    return geometry;
  }
  const uint32_t longEdge = std::max(canvasWidth, canvasHeight);
  const uint32_t shortEdge = std::min(canvasWidth, canvasHeight);
  geometry.width = std::max<uint32_t>(
      1u, std::min<uint32_t>(
              static_cast<uint32_t>((static_cast<uint64_t>(canvasWidth) * 45u) / 100u),
              static_cast<uint32_t>((static_cast<uint64_t>(longEdge) * 28u) / 100u)));
  geometry.height = std::max<uint32_t>(
      1u, static_cast<uint32_t>(
              (static_cast<uint64_t>(geometry.width) * pipHeight) / pipWidth));
  geometry.margin = std::max<uint32_t>(8u, shortEdge / 45u);
  geometry.border = std::max<uint32_t>(2u, shortEdge / 270u);
  if (geometry.width + geometry.margin >= canvasWidth ||
      geometry.height + geometry.margin >= canvasHeight) {
    return geometry;
  }
  geometry.x = canvasWidth - geometry.width - geometry.margin;
  geometry.y = canvasHeight - geometry.height - geometry.margin;
  geometry.visible = true;
  return geometry;
}

}  // namespace broadify::meeting
