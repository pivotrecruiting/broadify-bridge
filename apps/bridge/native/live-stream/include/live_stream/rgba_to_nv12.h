#pragma once

#include <cstdint>

#include "live_stream/nv12_layout.h"

namespace broadify::live {

/** Byte order of a 32-bit pixel in memory; the fourth byte (alpha) is ignored. */
enum class RgbaOrder { Rgba, Bgra };

/**
 * Converts 8-bit RGBA/BGRA to NV12 with the BT.709 matrix in limited range
 * (Y 16-235, CbCr 16-240). Chroma is the average of the 2x2 block it covers;
 * with odd dimensions the last column/row is replicated.
 *
 * `srcStride` is bytes per source row (>= 4 * width). Source and destination
 * must not overlap. Returns false without writing when a pointer is null, a
 * dimension is 0 or a stride is too small for `width`.
 *
 * Scalar implementation (16-bit fixed point), no hand-written SIMD.
 */
bool rgbaToNv12(const uint8_t *src, uint32_t srcStride, uint32_t width, uint32_t height, RgbaOrder order,
                const Nv12Planes &dst);

}  // namespace broadify::live
