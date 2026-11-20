#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "common/live_types.h"

namespace broadify::pgm {

/** Standard base64 with padding, no line breaks. */
std::string base64Encode(const uint8_t *data, size_t size);

/**
 * JPEG of a frame in CPU memory (`planes` set: "nv12", "yuy2", "uyvy", "bgra",
 * "rgba") as base64, for platforms without an image framework. The frame goes
 * to NV12 first (live_stream's frameToNv12, no scaling) and from there to RGB
 * with the BT.709 video-range matrix the encoder signals. `quality` is 0..1.
 * Empty on failure; `outWidth`/`outHeight` are only set on success.
 */
std::string jpegBase64FromPlanes(const CapturedFrame &frame, double quality, uint32_t &outWidth, uint32_t &outHeight);

}  // namespace broadify::pgm
