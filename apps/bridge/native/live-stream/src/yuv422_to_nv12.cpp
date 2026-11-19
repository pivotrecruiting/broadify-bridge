#include "live_stream/yuv422_to_nv12.h"

#include <cstddef>

namespace broadify::live {

bool yuv422ToNv12(const uint8_t *src, uint32_t srcStride, uint32_t width, uint32_t height, Yuv422Order order,
                  const Nv12Planes &dst) {
  if (!src || height == 0 || !nv12PlanesFit(dst.y, dst.yStride, dst.uv, dst.uvStride, width)) return false;
  const uint32_t chromaWidth = nv12ChromaWidth(width);
  if (srcStride / 4 < chromaWidth) return false;

  const uint32_t yOff = order == Yuv422Order::Yuy2 ? 0u : 1u;
  const uint32_t cOff = 1u - yOff;

  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t *s = src + static_cast<size_t>(y) * srcStride + yOff;
    uint8_t *d = dst.y + static_cast<size_t>(y) * dst.yStride;
    for (uint32_t x = 0; x < width; ++x) d[x] = s[2 * x];
  }

  const uint32_t chromaRows = nv12ChromaRows(height);
  for (uint32_t cy = 0; cy < chromaRows; ++cy) {
    const uint32_t y0 = 2 * cy;
    const uint32_t y1 = y0 + 1 < height ? y0 + 1 : y0;
    const uint8_t *s0 = src + static_cast<size_t>(y0) * srcStride + cOff;
    const uint8_t *s1 = src + static_cast<size_t>(y1) * srcStride + cOff;
    uint8_t *d = dst.uv + static_cast<size_t>(cy) * dst.uvStride;
    // Chroma bytes sit at every second position: Cb, Cr, Cb, Cr ... - the same
    // order NV12 wants, so one loop covers both components.
    for (uint32_t i = 0; i < 2 * chromaWidth; ++i) {
      d[i] = static_cast<uint8_t>((static_cast<uint32_t>(s0[2 * i]) + s1[2 * i] + 1u) >> 1);
    }
  }
  return true;
}

}  // namespace broadify::live
