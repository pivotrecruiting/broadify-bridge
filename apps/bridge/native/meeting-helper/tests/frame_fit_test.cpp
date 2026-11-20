// Covers the contain-fit that delivers a portrait program (1080x1920) to the
// 16:9-only virtual camera as a pillarboxed 1920x1080 frame: geometry mapping,
// rectangle math, opaque black bars and the untouched landscape path.
#include "util/frame_fit.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <vector>

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

namespace {

using broadify::meeting::containRect;
using broadify::meeting::fitContainRgba;
using broadify::meeting::fitContainRgbaScalar;
using broadify::meeting::FitRect;
using broadify::meeting::FrameGeometry;
using broadify::meeting::vcamOutputGeometry;

using FitFunction = bool (*)(const uint8_t *, uint32_t, uint32_t, size_t,
                             uint8_t *, uint32_t, uint32_t, size_t);

std::vector<uint8_t> solidFrame(uint32_t width, uint32_t height, uint8_t r,
                                uint8_t g, uint8_t b, uint8_t a) {
  std::vector<uint8_t> frame(static_cast<size_t>(width) * height * 4u);
  for (size_t offset = 0; offset < frame.size(); offset += 4u) {
    frame[offset + 0u] = r;
    frame[offset + 1u] = g;
    frame[offset + 2u] = b;
    frame[offset + 3u] = a;
  }
  return frame;
}

std::vector<uint8_t> patternFrame(uint32_t width, uint32_t height) {
  std::vector<uint8_t> frame(static_cast<size_t>(width) * height * 4u);
  for (size_t i = 0; i < frame.size(); ++i) {
    frame[i] = static_cast<uint8_t>((i * 31u + 7u) & 0xffu);
  }
  return frame;
}

const uint8_t *pixelAt(const std::vector<uint8_t> &frame, uint32_t width,
                       uint32_t x, uint32_t y) {
  return frame.data() + (static_cast<size_t>(y) * width + x) * 4u;
}

bool isPixel(const uint8_t *pixel, uint8_t r, uint8_t g, uint8_t b, uint8_t a,
             int tolerance = 0) {
  return std::abs(static_cast<int>(pixel[0]) - r) <= tolerance &&
         std::abs(static_cast<int>(pixel[1]) - g) <= tolerance &&
         std::abs(static_cast<int>(pixel[2]) - b) <= tolerance &&
         std::abs(static_cast<int>(pixel[3]) - a) <= tolerance;
}

void testVcamOutputGeometry() {
  // Landscape and square canvases pass through unchanged.
  FrameGeometry geometry = vcamOutputGeometry(1920, 1080);
  CHECK(geometry.width == 1920u && geometry.height == 1080u);
  geometry = vcamOutputGeometry(1280, 720);
  CHECK(geometry.width == 1280u && geometry.height == 720u);
  geometry = vcamOutputGeometry(1080, 1080);
  CHECK(geometry.width == 1080u && geometry.height == 1080u);
  geometry = vcamOutputGeometry(2, 2);
  CHECK(geometry.width == 2u && geometry.height == 2u);
  geometry = vcamOutputGeometry(0, 0);
  CHECK(geometry.width == 0u && geometry.height == 0u);
  // Portrait canvases are delivered inside 1920x1080.
  geometry = vcamOutputGeometry(1080, 1920);
  CHECK(geometry.width == 1920u && geometry.height == 1080u);
  geometry = vcamOutputGeometry(720, 1280);
  CHECK(geometry.width == 1920u && geometry.height == 1080u);
}

void testContainRect() {
  // 9:16 into 16:9: full height, centered pillarbox.
  FitRect rect = containRect(1080, 1920, 1920, 1080);
  CHECK(rect.width == 608u && rect.height == 1080u);
  CHECK(rect.x == 656u && rect.y == 0u);
  // Same aspect: the whole destination.
  rect = containRect(1280, 720, 1920, 1080);
  CHECK(rect.x == 0u && rect.y == 0u && rect.width == 1920u &&
        rect.height == 1080u);
  rect = containRect(1920, 1080, 1920, 1080);
  CHECK(rect.x == 0u && rect.y == 0u && rect.width == 1920u &&
        rect.height == 1080u);
  // Wider source: letterbox.
  rect = containRect(1920, 1080, 1080, 1920);
  CHECK(rect.width == 1080u && rect.height == 608u);
  CHECK(rect.x == 0u && rect.y == 656u);
  // 4:3 into 16:9.
  rect = containRect(640, 480, 1920, 1080);
  CHECK(rect.width == 1440u && rect.height == 1080u && rect.x == 240u &&
        rect.y == 0u);
  // Extreme aspect never collapses to an empty rectangle.
  rect = containRect(1, 10000, 1920, 1080);
  CHECK(rect.width == 1u && rect.height == 1080u);
  // Degenerate inputs.
  rect = containRect(0, 1080, 1920, 1080);
  CHECK(rect.width == 0u && rect.height == 0u);
  rect = containRect(1080, 1920, 0, 0);
  CHECK(rect.width == 0u && rect.height == 0u);
}

void testPortraitPillarbox(FitFunction fit) {
  constexpr uint32_t kSourceWidth = 1080u;
  constexpr uint32_t kSourceHeight = 1920u;
  constexpr uint32_t kWidth = 1920u;
  constexpr uint32_t kHeight = 1080u;
  const std::vector<uint8_t> source =
      solidFrame(kSourceWidth, kSourceHeight, 200, 40, 90, 255);
  // Pre-fill with garbage: every destination pixel must be written.
  std::vector<uint8_t> destination(static_cast<size_t>(kWidth) * kHeight * 4u,
                                   0x5au);
  CHECK(fit(source.data(), kSourceWidth, kSourceHeight, kSourceWidth * 4u,
            destination.data(), kWidth, kHeight, kWidth * 4u));
  const FitRect rect = containRect(kSourceWidth, kSourceHeight, kWidth, kHeight);
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (uint32_t x = 0; x < kWidth; ++x) {
      const uint8_t *pixel = pixelAt(destination, kWidth, x, y);
      const bool inside = x >= rect.x && x < rect.x + rect.width;
      if (inside) {
        // A flat source stays flat (1 step of resampling tolerance).
        CHECK(isPixel(pixel, 200, 40, 90, 255, 1));
      } else {
        CHECK(isPixel(pixel, 0, 0, 0, 255));
      }
    }
  }
}

void testLetterboxAndOrientation(FitFunction fit) {
  // 8x2 source (left half red, right half blue) into 8x8: bars top/bottom,
  // orientation preserved.
  std::vector<uint8_t> source(8u * 2u * 4u);
  for (uint32_t y = 0; y < 2u; ++y) {
    for (uint32_t x = 0; x < 8u; ++x) {
      uint8_t *pixel = source.data() + (static_cast<size_t>(y) * 8u + x) * 4u;
      pixel[0] = x < 4u ? 255u : 0u;
      pixel[1] = 0u;
      pixel[2] = x < 4u ? 0u : 255u;
      pixel[3] = 255u;
    }
  }
  std::vector<uint8_t> destination(8u * 8u * 4u, 0x5au);
  CHECK(fit(source.data(), 8u, 2u, 32u, destination.data(), 8u, 8u, 32u));
  const FitRect rect = containRect(8, 2, 8, 8);
  CHECK(rect.x == 0u && rect.y == 3u && rect.width == 8u && rect.height == 2u);
  for (uint32_t y = 0; y < 8u; ++y) {
    const bool inside = y >= rect.y && y < rect.y + rect.height;
    if (!inside) {
      for (uint32_t x = 0; x < 8u; ++x) {
        CHECK(isPixel(pixelAt(destination, 8u, x, y), 0, 0, 0, 255));
      }
      continue;
    }
    CHECK(isPixel(pixelAt(destination, 8u, 0u, y), 255, 0, 0, 255, 2));
    CHECK(isPixel(pixelAt(destination, 8u, 7u, y), 0, 0, 255, 255, 2));
  }
}

void testIdentity(FitFunction fit) {
  // Same size: an exact copy, also with padded strides on both sides.
  constexpr uint32_t kWidth = 16u;
  constexpr uint32_t kHeight = 9u;
  const std::vector<uint8_t> source = patternFrame(kWidth, kHeight);
  std::vector<uint8_t> destination(source.size(), 0u);
  CHECK(fit(source.data(), kWidth, kHeight, kWidth * 4u, destination.data(),
            kWidth, kHeight, kWidth * 4u));
  CHECK(destination == source);

  constexpr size_t kSourceStride = kWidth * 4u + 8u;
  constexpr size_t kDestinationStride = kWidth * 4u + 12u;
  std::vector<uint8_t> paddedSource(kSourceStride * kHeight, 0xeeu);
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (size_t i = 0; i < kWidth * 4u; ++i) {
      paddedSource[y * kSourceStride + i] =
          source[static_cast<size_t>(y) * kWidth * 4u + i];
    }
  }
  std::vector<uint8_t> paddedDestination(kDestinationStride * kHeight, 0x11u);
  CHECK(fit(paddedSource.data(), kWidth, kHeight, kSourceStride,
            paddedDestination.data(), kWidth, kHeight, kDestinationStride));
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (size_t i = 0; i < kDestinationStride; ++i) {
      const uint8_t value = paddedDestination[y * kDestinationStride + i];
      if (i < kWidth * 4u) {
        CHECK(value == source[static_cast<size_t>(y) * kWidth * 4u + i]);
      } else {
        // Stride padding is never written.
        CHECK(value == 0x11u);
      }
    }
  }
}

void testInvalidArguments(FitFunction fit) {
  const std::vector<uint8_t> source = solidFrame(4, 8, 1, 2, 3, 255);
  std::vector<uint8_t> destination(8u * 4u * 4u, 0x77u);
  const std::vector<uint8_t> untouched = destination;
  CHECK(!fit(nullptr, 4u, 8u, 16u, destination.data(), 8u, 4u, 32u));
  CHECK(!fit(source.data(), 4u, 8u, 16u, nullptr, 8u, 4u, 32u));
  CHECK(!fit(source.data(), 0u, 8u, 16u, destination.data(), 8u, 4u, 32u));
  CHECK(!fit(source.data(), 4u, 8u, 16u, destination.data(), 8u, 0u, 32u));
  // Strides shorter than a pixel row.
  CHECK(!fit(source.data(), 4u, 8u, 15u, destination.data(), 8u, 4u, 32u));
  CHECK(!fit(source.data(), 4u, 8u, 16u, destination.data(), 8u, 4u, 31u));
  CHECK(destination == untouched);
}

void runAll(FitFunction fit) {
  testPortraitPillarbox(fit);
  testLetterboxAndOrientation(fit);
  testIdentity(fit);
  testInvalidArguments(fit);
}

}  // namespace

int main() {
  testVcamOutputGeometry();
  testContainRect();
  // The platform path (vImage on Apple) and the portable path share the
  // contract; on non-Apple platforms both names run the scalar code.
  runAll(&fitContainRgba);
  runAll(&fitContainRgbaScalar);
  std::cout << "frame_fit_test passed\n";
  return 0;
}
