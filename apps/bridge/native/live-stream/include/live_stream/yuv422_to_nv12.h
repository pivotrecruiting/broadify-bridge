#pragma once

#include <cstdint>

#include "live_stream/nv12_layout.h"

namespace broadify::live {

/** Packed 4:2:2 byte order: YUY2 = Y0 Cb Y1 Cr, UYVY = Cb Y0 Cr Y1. */
enum class Yuv422Order { Yuy2, Uyvy };

/**
 * Converts packed 8-bit 4:2:2 to NV12 without an RGB round trip: luma is
 * copied, chroma is the rounded average of each pair of rows (an odd last row
 * is copied). Range and matrix are passed through untouched.
 *
 * `srcStride` is bytes per source row and must hold whole macropixels
 * (>= 4 * ceil(width / 2)); with an odd width the last macropixel contributes
 * one luma sample and its chroma. Source and destination must not overlap.
 * Returns false without writing when a pointer is null, a dimension is 0 or a
 * stride is too small for `width`.
 */
bool yuv422ToNv12(const uint8_t *src, uint32_t srcStride, uint32_t width, uint32_t height, Yuv422Order order,
                  const Nv12Planes &dst);

}  // namespace broadify::live
