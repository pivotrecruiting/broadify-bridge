#include "live_stream/nv12_scale.h"

#include <cstddef>
#include <cstring>
#include <vector>

namespace broadify::live {

namespace {

/** Source position of one output sample: left/top neighbour, its successor and the weight of the successor (0..256). */
struct Tap {
  uint32_t i0 = 0;
  uint32_t i1 = 0;
  uint32_t w1 = 0;
};

// src = (dst + 0.5) * srcSize / dstSize - 0.5, clamped to the plane, in 16.16.
std::vector<Tap> buildTaps(uint32_t srcSize, uint32_t dstSize) {
  std::vector<Tap> taps(dstSize);
  for (uint32_t d = 0; d < dstSize; ++d) {
    int64_t pos = ((2 * static_cast<int64_t>(d) + 1) * srcSize * 65536) / (2 * static_cast<int64_t>(dstSize)) - 32768;
    if (pos < 0) pos = 0;
    uint32_t i0 = static_cast<uint32_t>(pos >> 16);
    uint32_t w1 = (static_cast<uint32_t>(pos & 0xffff) + 128u) >> 8;
    if (i0 >= srcSize - 1) {
      i0 = srcSize - 1;
      w1 = 0;
    }
    taps[d].i0 = i0;
    taps[d].i1 = i0 + 1 < srcSize ? i0 + 1 : i0;
    taps[d].w1 = w1;
  }
  return taps;
}

// One plane with `channels` interleaved 8-bit components per sample (Y: 1, CbCr: 2).
void scalePlane(const uint8_t *src, uint32_t srcStride, uint32_t srcWidth, uint32_t srcHeight, uint8_t *dst,
                uint32_t dstStride, uint32_t dstWidth, uint32_t dstHeight, uint32_t channels) {
  if (srcWidth == dstWidth && srcHeight == dstHeight) {
    for (uint32_t y = 0; y < dstHeight; ++y) {
      std::memcpy(dst + static_cast<size_t>(y) * dstStride, src + static_cast<size_t>(y) * srcStride,
                  static_cast<size_t>(dstWidth) * channels);
    }
    return;
  }
  const std::vector<Tap> xTaps = buildTaps(srcWidth, dstWidth);
  const std::vector<Tap> yTaps = buildTaps(srcHeight, dstHeight);
  for (uint32_t y = 0; y < dstHeight; ++y) {
    const Tap &ty = yTaps[y];
    const uint8_t *r0 = src + static_cast<size_t>(ty.i0) * srcStride;
    const uint8_t *r1 = src + static_cast<size_t>(ty.i1) * srcStride;
    uint8_t *d = dst + static_cast<size_t>(y) * dstStride;
    const uint32_t wy1 = ty.w1, wy0 = 256u - ty.w1;
    for (uint32_t x = 0; x < dstWidth; ++x) {
      const Tap &tx = xTaps[x];
      const uint32_t wx1 = tx.w1, wx0 = 256u - tx.w1;
      for (uint32_t c = 0; c < channels; ++c) {
        const uint32_t a0 = tx.i0 * channels + c, a1 = tx.i1 * channels + c;
        const uint32_t top = r0[a0] * wx0 + r0[a1] * wx1;
        const uint32_t bottom = r1[a0] * wx0 + r1[a1] * wx1;
        d[x * channels + c] = static_cast<uint8_t>((top * wy0 + bottom * wy1 + 32768u) >> 16);
      }
    }
  }
}

}  // namespace

bool scaleNv12(const Nv12ConstPlanes &src, uint32_t srcWidth, uint32_t srcHeight, const Nv12Planes &dst,
               uint32_t dstWidth, uint32_t dstHeight) {
  if (srcHeight == 0 || dstHeight == 0) return false;
  if (!nv12PlanesFit(src.y, src.yStride, src.uv, src.uvStride, srcWidth)) return false;
  if (!nv12PlanesFit(dst.y, dst.yStride, dst.uv, dst.uvStride, dstWidth)) return false;
  scalePlane(src.y, src.yStride, srcWidth, srcHeight, dst.y, dst.yStride, dstWidth, dstHeight, 1);
  scalePlane(src.uv, src.uvStride, nv12ChromaWidth(srcWidth), nv12ChromaRows(srcHeight), dst.uv, dst.uvStride,
             nv12ChromaWidth(dstWidth), nv12ChromaRows(dstHeight), 2);
  return true;
}

}  // namespace broadify::live
