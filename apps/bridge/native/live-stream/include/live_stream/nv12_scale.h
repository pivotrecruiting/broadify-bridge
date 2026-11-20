#pragma once

#include <cstdint>

#include "live_stream/nv12_layout.h"

namespace broadify::live {

/**
 * Resamples NV12 to another size (encode target != source), bilinear with
 * pixel-centre alignment on both planes. An exact 2:1 reduction is therefore a
 * 2x2 box average and equal sizes are a plain copy. Reductions beyond 2:1 skip
 * source pixels (no pre-filter): fine for 4K -> 1080p and 1080p -> 720p, not
 * meant for thumbnails. The aspect ratio is not preserved - pass a target with
 * the source's aspect.
 *
 * Source and destination must not overlap. Returns false without writing when
 * a pointer is null, a dimension is 0 or a stride is too small for its width.
 */
bool scaleNv12(const Nv12ConstPlanes &src, uint32_t srcWidth, uint32_t srcHeight, const Nv12Planes &dst,
               uint32_t dstWidth, uint32_t dstHeight);

}  // namespace broadify::live
