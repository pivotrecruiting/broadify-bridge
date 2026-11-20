#pragma once

#import <CoreVideo/CoreVideo.h>

#include <cstddef>
#include <cstdint>

namespace broadify::meeting {

/**
 * Pool of IOSurface-backed BGRA pixel buffers the program stream converts
 * program frames into. The buffers have the size of the program FRAME, never
 * of the encode target: the copy writes frame-size rows and VideoToolbox
 * scales to the session size (as it does for the PGM helper's capture
 * buffers). Split from ProgramStream so the pool + copy step can be driven by
 * a test without WebRTC. Not thread-safe: the owner serialises access.
 */
class ProgramFramePool {
 public:
  ProgramFramePool() = default;
  ~ProgramFramePool();
  ProgramFramePool(const ProgramFramePool &) = delete;
  ProgramFramePool &operator=(const ProgramFramePool &) = delete;

  /**
   * Makes the pool hand out `width` x `height` buffers: kept when the size is
   * unchanged, recreated when the program frame size changed. False for an
   * empty size or if CoreVideo refuses (the pool is then empty).
   */
  bool ensure(uint32_t width, uint32_t height);
  /** A pooled buffer (+1 retained) or nullptr when the pool is missing or exhausted: drop, never block. */
  CVPixelBufferRef createBuffer();
  void reset();

 private:
  CVPixelBufferPoolRef pool_ = nullptr;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
};

/**
 * One RGBA→BGRA pass of a `width` x `height` program frame into `pixelBuffer`.
 * Bounded by the buffer's real geometry: returns false (nothing written) when
 * the buffer is not a BGRA buffer of exactly that size, its rows are too
 * short, or `rgbaSize` does not cover the frame. The caller drops the frame.
 */
bool copyRgbaFrameToPixelBuffer(const uint8_t *rgba, size_t rgbaSize, uint32_t width, uint32_t height,
                                CVPixelBufferRef pixelBuffer);

}  // namespace broadify::meeting
