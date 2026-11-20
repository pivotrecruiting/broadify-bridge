#pragma once

#include "live_stream/nv12_layout.h"
#include "live_stream/video_frame.h"

#include <cstdint>
#include <vector>

namespace broadify::live {

/**
 * Brings a frame in CPU memory (`planes` set) into NV12 of the encode size,
 * for encoders that neither convert nor scale themselves (Media Foundation;
 * VideoToolbox does both on its own). "nv12" is copied or scaled, "yuy2" /
 * "uyvy" go straight to NV12 without an RGB round trip, "bgra" / "rgba" use
 * the BT.709 limited-range matrix. A size change runs through `scratch`
 * (source-size NV12, reused between calls) and the bilinear scaler; the
 * aspect ratio is not preserved.
 *
 * `dst` must hold dstWidth x dstHeight. Returns false, with `dst` unspecified,
 * for an unknown pixel format, a frame without planes or planes too small for
 * the frame's size.
 */
bool frameToNv12(const CapturedFrame &frame, const Nv12Planes &dst, uint32_t dstWidth, uint32_t dstHeight,
                 std::vector<uint8_t> &scratch);

}  // namespace broadify::live
