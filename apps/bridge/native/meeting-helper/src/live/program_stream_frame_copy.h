#pragma once

#import <CoreVideo/CoreVideo.h>

#include <cstddef>
#include <cstdint>

namespace broadify::meeting {

/**
 * Pool of IOSurface-backed BGRA pixel buffers the program stream converts
 * program frames into. Split from ProgramStream so the pool + copy step can be
 * driven by a test without WebRTC. Not thread-safe: the owner serialises access.
 */
class ProgramFramePool {
 public:
  ProgramFramePool() = default;
  ~ProgramFramePool();
  ProgramFramePool(const ProgramFramePool &) = delete;
  ProgramFramePool &operator=(const ProgramFramePool &) = delete;

  /** (Re)creates the pool for `width` x `height` buffers. False if CoreVideo refuses. */
  bool configure(uint32_t width, uint32_t height);
  /** A pooled buffer (+1 retained) or nullptr when the pool is missing or exhausted: drop, never block. */
  CVPixelBufferRef createBuffer();
  void reset();

 private:
  CVPixelBufferPoolRef pool_ = nullptr;
};

/**
 * One RGBA→BGRA pass of a `width` x `height` program frame into `pixelBuffer`.
 * Returns false (nothing written) when `rgbaSize` does not cover the frame.
 */
bool copyRgbaFrameToPixelBuffer(const uint8_t *rgba, size_t rgbaSize, uint32_t width, uint32_t height,
                                CVPixelBufferRef pixelBuffer);

}  // namespace broadify::meeting
