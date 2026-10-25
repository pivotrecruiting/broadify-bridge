#pragma once

#include <cstdint>
#include <deque>
#include <string>

namespace broadify::pgm {

/** Measured signal, derived from real frames (never from device claims). */
struct VideoSignal {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fpsNum = 0;
  uint32_t fpsDen = 1;
  std::string pixelFormat = "unknown";
  bool noSignal = true;
};

/**
 * Tracks what a source actually delivers: dimensions and pixel format from the
 * last frame, frame rate from the median inter-frame interval over a sliding
 * window, "no signal" when nothing arrived for `noSignalAfterNs`. Pure; the
 * caller feeds timestamps so tests are deterministic.
 */
class VideoSignalTracker {
 public:
  explicit VideoSignalTracker(uint64_t noSignalAfterNs = 1'000'000'000ULL, size_t windowFrames = 60);

  /** Returns true when the signal changed in a way the encoder must react to (size, fps bucket, format, no_signal). */
  bool onFrame(uint32_t width, uint32_t height, const std::string &pixelFormat, uint64_t captureNs);

  /** Called periodically; returns true when the no-signal state flipped. */
  bool onTick(uint64_t nowNs);

  /** Marks the signal lost explicitly (DeckLink no-input flag, device removal). */
  bool markNoSignal();

  const VideoSignal &signal() const { return signal_; }

 private:
  static void snapFps(double fps, uint32_t &num, uint32_t &den);

  uint64_t noSignalAfterNs_;
  size_t windowFrames_;
  std::deque<uint64_t> timestamps_;
  uint64_t lastFrameNs_ = 0;
  VideoSignal signal_;
};

}  // namespace broadify::pgm
