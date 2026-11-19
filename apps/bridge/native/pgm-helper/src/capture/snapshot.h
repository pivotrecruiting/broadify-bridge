#pragma once

#include <cstdint>
#include <string>

#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>
#endif

namespace broadify::pgm {

/** JPEG of a frame as base64 (fits the relay's 2 MB JSON cap at 1080p / quality 0.8). Empty on failure. */
#if defined(__APPLE__)
std::string jpegBase64FromPixelBuffer(CVPixelBufferRef buffer, double quality, uint32_t &outWidth, uint32_t &outHeight);
#endif

}  // namespace broadify::pgm
