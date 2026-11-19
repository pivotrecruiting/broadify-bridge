#include "live_stream/rgba_to_nv12.h"

#include <cstddef>

namespace broadify::live {

namespace {

// BT.709 limited range, coefficients scaled by 65536:
//   Y  = 16  + 219/255 * ( 0.2126 R + 0.7152 G + 0.0722 B)
//   Cb = 128 + 224/255 * (B - Y') / 1.8556
//   Cr = 128 + 224/255 * (R - Y') / 1.5748
// The chroma rows sum to 0 so every grey lands on exactly 128.
constexpr int32_t kYR = 11966, kYG = 40254, kYB = 4064;
constexpr int32_t kCbR = -6596, kCbG = -22188, kCbB = 28784;
constexpr int32_t kCrR = 28784, kCrG = -26145, kCrB = -2639;

}  // namespace

bool rgbaToNv12(const uint8_t *src, uint32_t srcStride, uint32_t width, uint32_t height, RgbaOrder order,
                const Nv12Planes &dst) {
  if (!src || height == 0 || !nv12PlanesFit(dst.y, dst.yStride, dst.uv, dst.uvStride, width)) return false;
  if (srcStride / 4 < width) return false;

  const uint32_t rOff = order == RgbaOrder::Rgba ? 0u : 2u;
  const uint32_t bOff = 2u - rOff;

  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t *s = src + static_cast<size_t>(y) * srcStride;
    uint8_t *d = dst.y + static_cast<size_t>(y) * dst.yStride;
    for (uint32_t x = 0; x < width; ++x) {
      const int32_t r = s[4 * x + rOff], g = s[4 * x + 1], b = s[4 * x + bOff];
      d[x] = static_cast<uint8_t>((kYR * r + kYG * g + kYB * b + (16 << 16) + (1 << 15)) >> 16);
    }
  }

  const uint32_t chromaWidth = nv12ChromaWidth(width);
  const uint32_t chromaRows = nv12ChromaRows(height);
  for (uint32_t cy = 0; cy < chromaRows; ++cy) {
    const uint32_t y0 = 2 * cy;
    const uint32_t y1 = y0 + 1 < height ? y0 + 1 : y0;
    const uint8_t *s0 = src + static_cast<size_t>(y0) * srcStride;
    const uint8_t *s1 = src + static_cast<size_t>(y1) * srcStride;
    uint8_t *d = dst.uv + static_cast<size_t>(cy) * dst.uvStride;
    for (uint32_t cx = 0; cx < chromaWidth; ++cx) {
      const uint32_t x0 = 2 * cx;
      const uint32_t x1 = x0 + 1 < width ? x0 + 1 : x0;
      // Sum of the 2x2 block (0..1020); the extra factor 4 is folded into the shift.
      const int32_t r = s0[4 * x0 + rOff] + s0[4 * x1 + rOff] + s1[4 * x0 + rOff] + s1[4 * x1 + rOff];
      const int32_t g = s0[4 * x0 + 1] + s0[4 * x1 + 1] + s1[4 * x0 + 1] + s1[4 * x1 + 1];
      const int32_t b = s0[4 * x0 + bOff] + s0[4 * x1 + bOff] + s1[4 * x0 + bOff] + s1[4 * x1 + bOff];
      d[2 * cx] = static_cast<uint8_t>((kCbR * r + kCbG * g + kCbB * b + (128 << 18) + (1 << 17)) >> 18);
      d[2 * cx + 1] = static_cast<uint8_t>((kCrR * r + kCrG * g + kCrB * b + (128 << 18) + (1 << 17)) >> 18);
    }
  }
  return true;
}

}  // namespace broadify::live
