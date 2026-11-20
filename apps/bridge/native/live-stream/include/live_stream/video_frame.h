#pragma once

#include <cstdint>
#include <string>

#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>
#endif

namespace broadify::live {

/** One plane of a frame in CPU memory; `stride` is bytes per row, `rows` the plane's row count. */
struct FramePlane {
  const uint8_t *data = nullptr;
  uint32_t stride = 0;
  uint32_t rows = 0;
};

/** A video frame in its native pixel format; the buffer is retained for the callback's duration only. */
struct CapturedFrame {
#if defined(__APPLE__)
  CVPixelBufferRef pixelBuffer = nullptr;
#endif
  /**
   * Portable view of the pixels for platforms without a CVPixelBuffer:
   * `planeCount` planes in format order (NV12: Y, CbCr; packed formats: one).
   * 0 planes means the frame is only reachable through its platform buffer.
   */
  FramePlane planes[3];
  uint32_t planeCount = 0;
  /**
   * Opaque platform sample, borrowed for the callback (Windows: IMFSample*); nullptr elsewhere.
   * Informational only: the encoders read `pixelBuffer` / `planes` and neither keep nor forward it.
   */
  void *nativeHandle = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  std::string pixelFormat;  // "nv12" | "uyvy" | "yuy2" | "bgra"
  uint64_t captureNs = 0;   // monotonic host clock (see monotonic_clock.h)
};

}  // namespace broadify::live
