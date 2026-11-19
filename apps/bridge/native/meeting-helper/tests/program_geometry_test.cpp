// Pins the compositor geometry that changed for portrait programs: on a 16:9
// canvas the keyed-presenter scale and the camera PiP inset must be exactly
// the former width-relative values; on a 9:16 canvas the presenter is scaled
// uniformly (cover) and the inset is sized against the short edge.
#include "compose/program_geometry.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

namespace {

using broadify::meeting::cameraPipInsetGeometry;
using broadify::meeting::CameraPipInsetGeometry;
using broadify::meeting::keyedPresenterCoverScale;

// The geometry drawCameraPipInset used before the portrait change.
struct LegacyPipInset {
  bool visible = false;
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t margin = 0;
  uint32_t border = 0;
};

LegacyPipInset legacyPipInset(uint32_t width, uint32_t height,
                              uint32_t pipWidth, uint32_t pipHeight) {
  LegacyPipInset inset;
  inset.width = std::max<uint32_t>(1u, (width * 28u) / 100u);
  inset.height = std::max<uint32_t>(
      1u, static_cast<uint32_t>(
              (static_cast<uint64_t>(inset.width) * pipHeight) / pipWidth));
  inset.margin = std::max<uint32_t>(8u, width / 80u);
  inset.border = std::max<uint32_t>(2u, width / 480u);
  if (inset.width + inset.margin >= width ||
      inset.height + inset.margin >= height) {
    return inset;
  }
  inset.x = width - inset.width - inset.margin;
  inset.y = height - inset.height - inset.margin;
  inset.visible = true;
  return inset;
}

void expectPipParity(uint32_t width, uint32_t height, uint32_t pipWidth,
                     uint32_t pipHeight) {
  const LegacyPipInset legacy =
      legacyPipInset(width, height, pipWidth, pipHeight);
  const CameraPipInsetGeometry current =
      cameraPipInsetGeometry(width, height, pipWidth, pipHeight);
  CHECK(current.visible == legacy.visible);
  CHECK(current.width == legacy.width);
  CHECK(current.height == legacy.height);
  CHECK(current.margin == legacy.margin);
  CHECK(current.border == legacy.border);
  CHECK(current.x == legacy.x);
  CHECK(current.y == legacy.y);
}

void testKeyedPresenterScale() {
  // Matching aspect: exactly the former per-axis factors (kx == ky).
  const struct {
    uint32_t canvasWidth, canvasHeight, sourceWidth, sourceHeight;
  } sameAspect[] = {
      {1920, 1080, 1920, 1080}, {1920, 1080, 1280, 720},
      {1920, 1080, 3840, 2160}, {1920, 1080, 960, 540},
      {1280, 720, 1920, 1080},  {1280, 720, 1280, 720},
  };
  for (const auto &entry : sameAspect) {
    const double legacyKx = static_cast<double>(entry.canvasWidth) /
                            static_cast<double>(entry.sourceWidth);
    const double legacyKy = static_cast<double>(entry.canvasHeight) /
                            static_cast<double>(entry.sourceHeight);
    const double scale = keyedPresenterCoverScale(
        entry.canvasWidth, entry.canvasHeight, entry.sourceWidth,
        entry.sourceHeight);
    CHECK(scale == legacyKx);
    CHECK(scale == legacyKy);
  }

  // Portrait canvas with a landscape camera: uniform cover, i.e. the camera
  // height fills the canvas height and the sides are cropped (no squeeze).
  const double portrait = keyedPresenterCoverScale(1080, 1920, 1920, 1080);
  CHECK(portrait == 1920.0 / 1080.0);
  CHECK(portrait * 1080.0 >= 1920.0);
  CHECK(portrait * 1920.0 >= 1080.0);
  // 4:3 camera on a 16:9 canvas: covers the width instead of stretching.
  CHECK(keyedPresenterCoverScale(1920, 1080, 640, 480) == 3.0);
  // Degenerate input never divides by zero.
  CHECK(keyedPresenterCoverScale(1920, 1080, 0, 0) == 1.0);
  CHECK(keyedPresenterCoverScale(0, 0, 1920, 1080) == 1.0);
}

void testCameraPipInset() {
  // 16:9 canvases: unchanged against the former width-relative geometry, for
  // 16:9 and 4:3 PiP cameras.
  const uint32_t canvases[][2] = {
      {1920, 1080}, {1280, 720}, {3840, 2160}, {960, 540}, {640, 360}};
  for (const auto &canvas : canvases) {
    expectPipParity(canvas[0], canvas[1], 1920, 1080);
    expectPipParity(canvas[0], canvas[1], 1280, 720);
    expectPipParity(canvas[0], canvas[1], 640, 480);
  }
  const CameraPipInsetGeometry fullHd =
      cameraPipInsetGeometry(1920, 1080, 1920, 1080);
  CHECK(fullHd.visible);
  CHECK(fullHd.width == 537u && fullHd.height == 302u);
  CHECK(fullHd.margin == 24u && fullHd.border == 4u);
  CHECK(fullHd.x == 1359u && fullHd.y == 754u);

  // Portrait canvas: capped at 45% of the width, same margin/border as the
  // landscape canvas with the same short edge.
  const CameraPipInsetGeometry portrait =
      cameraPipInsetGeometry(1080, 1920, 1920, 1080);
  CHECK(portrait.visible);
  CHECK(portrait.width == 486u && portrait.height == 273u);
  CHECK(portrait.margin == 24u && portrait.border == 4u);
  CHECK(portrait.x == 1080u - 486u - 24u);
  CHECK(portrait.y == 1920u - 273u - 24u);
  CHECK(portrait.x >= portrait.border && portrait.y >= portrait.border);

  // Degenerate input draws nothing.
  CHECK(!cameraPipInsetGeometry(0, 0, 1920, 1080).visible);
  CHECK(!cameraPipInsetGeometry(1920, 1080, 0, 0).visible);
  // An inset taller than the canvas is skipped, as before.
  CHECK(!cameraPipInsetGeometry(1920, 200, 100, 1000).visible);
}

}  // namespace

int main() {
  testKeyedPresenterScale();
  testCameraPipInset();
  std::cout << "program_geometry_test passed\n";
  return 0;
}
