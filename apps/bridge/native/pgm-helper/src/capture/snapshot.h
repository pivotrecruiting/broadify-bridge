#pragma once

#include <cstdint>
#include <string>

#include "common/live_types.h"

namespace broadify::pgm {

/** JPEG of a frame as base64 (fits the relay's 2 MB JSON cap at 1080p / quality 0.8). Empty on failure. */
std::string jpegBase64FromFrame(const CapturedFrame &frame, double quality, uint32_t &outWidth, uint32_t &outHeight);

}  // namespace broadify::pgm
