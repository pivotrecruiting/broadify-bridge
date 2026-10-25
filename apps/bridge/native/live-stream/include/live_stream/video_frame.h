#pragma once

#include <cstdint>
#include <string>

#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>
#endif

namespace broadify::live {

/** A video frame in its native pixel format; the buffer is retained for the callback's duration only. */
struct CapturedFrame {
#if defined(__APPLE__)
  CVPixelBufferRef pixelBuffer = nullptr;
#endif
  uint32_t width = 0;
  uint32_t height = 0;
  std::string pixelFormat;  // "nv12" | "uyvy" | "yuy2" | "bgra"
  uint64_t captureNs = 0;   // monotonic host clock (see monotonic_clock.h)
};

}  // namespace broadify::live
