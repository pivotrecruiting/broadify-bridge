#include "util/pixel_swizzle.h"

#include <cstdint>
#include <iostream>
#include <vector>

using broadify::meeting::swizzleBgraToRgba;
using broadify::meeting::swizzleBgraToRgbaScalar;
using broadify::meeting::swizzleRgbaToBgra;
using broadify::meeting::swizzleRgbaToBgraScalar;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "pixel_swizzle_test failed: " << what << std::endl;
  }
  return condition;
}

std::vector<uint8_t> pattern(size_t bytes) {
  std::vector<uint8_t> data(bytes + 64u);
  for (size_t i = 0; i < data.size(); ++i) {
    data[i] = static_cast<uint8_t>((i * 37u + 11u) & 0xffu);
  }
  return data;
}

}  // namespace

int main() {
  bool ok = true;
  for (size_t pixels = 0; pixels < 65; ++pixels) {
    for (size_t srcAlign = 0; srcAlign < 16; ++srcAlign) {
      for (size_t dstAlign = 0; dstAlign < 16; ++dstAlign) {
        std::vector<uint8_t> src = pattern(pixels * 4u + srcAlign);
        std::vector<uint8_t> expected(pixels * 4u + dstAlign + 16u, 0xaa);
        std::vector<uint8_t> actual(pixels * 4u + dstAlign + 16u, 0xaa);
        swizzleRgbaToBgraScalar(src.data() + srcAlign, expected.data() + dstAlign, pixels);
        swizzleRgbaToBgra(src.data() + srcAlign, actual.data() + dstAlign, pixels);
        ok &= expect(expected == actual, "rgba->bgra matches scalar");
        swizzleBgraToRgbaScalar(src.data() + srcAlign, expected.data() + dstAlign, pixels, true);
        swizzleBgraToRgbaScalar(src.data() + srcAlign, actual.data() + dstAlign, pixels, true);
        ok &= expect(expected == actual, "bgra->rgba scalar force alpha");
      }
    }
  }

  std::vector<uint8_t> pitched = pattern(3u * 8u);
  std::vector<uint8_t> frame;
  swizzleBgraToRgba(pitched.data(), 8, 2, 3, frame);
  ok &= expect(frame.size() == 24u, "pitched output size");
  ok &= expect(frame[0] == pitched[2] && frame[3] == 255u, "pitched first pixel");
  return ok ? 0 : 1;
}
