#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace broadify::meeting {

void swizzleBgraToRgba(const uint8_t *scan0,
                       ptrdiff_t pitch,
                       uint32_t width,
                       uint32_t height,
                       std::vector<uint8_t> &destination);

void swizzleRgbaToBgra(const uint8_t *rgba, uint8_t *bgra, size_t pixelCount);
void swizzleBgraToRgbaScalar(const uint8_t *bgra,
                             uint8_t *rgba,
                             size_t pixelCount,
                             bool forceOpaqueAlpha);
void swizzleRgbaToBgraScalar(const uint8_t *rgba, uint8_t *bgra, size_t pixelCount);

}  // namespace broadify::meeting
