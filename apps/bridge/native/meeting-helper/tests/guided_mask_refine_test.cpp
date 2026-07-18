#include "pipeline/guided_mask_refine.h"

#include <algorithm>
#include <cstdint>
#include <iostream>

using broadify::meeting::AlphaMask;
using broadify::meeting::VideoFrame;
using broadify::meeting::guidedRefineMask;

int main() {
  constexpr uint32_t width = 64u;
  constexpr uint32_t height = 36u;
  VideoFrame guide;
  guide.width = width;
  guide.height = height;
  guide.timestampNs = 42u;
  guide.rgba.assign(static_cast<size_t>(width) * height * 4u, 255u);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const uint8_t luma = x < width / 2u ? 24u : 232u;
      const size_t offset = (static_cast<size_t>(y) * width + x) * 4u;
      guide.rgba[offset + 0u] = luma;
      guide.rgba[offset + 1u] = luma;
      guide.rgba[offset + 2u] = luma;
    }
  }

  AlphaMask mask;
  mask.width = 16u;
  mask.height = 9u;
  mask.timestampNs = guide.timestampNs;
  mask.alpha.assign(static_cast<size_t>(mask.width) * mask.height, 0u);
  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      mask.alpha[static_cast<size_t>(y) * mask.width + x] =
          x < mask.width / 2u ? 255u : 0u;
    }
  }

  guidedRefineMask(mask, guide);
  if (mask.width != width || mask.height != height ||
      mask.alpha.size() != static_cast<size_t>(width) * height) {
    std::cerr << "guided refine returned unexpected dimensions" << std::endl;
    return 1;
  }
  const auto [minimum, maximum] = std::minmax_element(mask.alpha.begin(), mask.alpha.end());
  if (minimum == mask.alpha.end() || maximum == mask.alpha.end() ||
      *minimum > 32u || *maximum < 223u) {
    std::cerr << "guided refine collapsed mask contrast" << std::endl;
    return 1;
  }
  if (mask.timestampNs != guide.timestampNs) {
    std::cerr << "guided refine changed mask timestamp" << std::endl;
    return 1;
  }
  return 0;
}
