#pragma once

#include <cstdint>

namespace broadify::live {

/**
 * NV12 in CPU memory: a full-resolution Y plane and one interleaved CbCr plane
 * at half resolution. Odd dimensions round the chroma plane up, so a WxH frame
 * has nv12ChromaWidth(W) CbCr pairs per row and nv12ChromaRows(H) chroma rows;
 * the last column/row then covers a single luma column/row.
 * Strides are bytes per row and may be larger than the visible row.
 */
inline uint32_t nv12ChromaWidth(uint32_t width) { return width / 2 + (width & 1u); }
inline uint32_t nv12ChromaRows(uint32_t height) { return height / 2 + (height & 1u); }

struct Nv12Planes {
  uint8_t *y = nullptr;
  uint32_t yStride = 0;
  uint8_t *uv = nullptr;
  uint32_t uvStride = 0;
};

struct Nv12ConstPlanes {
  const uint8_t *y = nullptr;
  uint32_t yStride = 0;
  const uint8_t *uv = nullptr;
  uint32_t uvStride = 0;
};

/** True when both planes are set and each stride holds a full row of a `width` wide frame. */
inline bool nv12PlanesFit(const uint8_t *y, uint32_t yStride, const uint8_t *uv, uint32_t uvStride, uint32_t width) {
  return y && uv && width > 0 && yStride >= width && uvStride / 2 >= nv12ChromaWidth(width);
}

}  // namespace broadify::live
