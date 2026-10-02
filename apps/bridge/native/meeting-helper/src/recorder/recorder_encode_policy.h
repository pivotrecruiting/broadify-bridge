#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace broadify::meeting {

constexpr double kRecorderBitsPerPixel = 0.35;
constexpr uint64_t kRecorderMinBitrateBps = 2'000'000ull;
constexpr uint64_t kRecorderMaxBitrateBps = 40'000'000ull;

inline uint64_t recorderVideoBitrateBps(uint32_t width, uint32_t height,
                                        uint32_t fps) {
  const uint32_t safeFps = fps > 0 ? fps : 30;
  const auto pixels = static_cast<double>(static_cast<uint64_t>(width) *
                                          static_cast<uint64_t>(height));
  const auto bitrate = static_cast<uint64_t>(
      std::llround(pixels * static_cast<double>(safeFps) *
                   kRecorderBitsPerPixel));
  return std::clamp(bitrate, kRecorderMinBitrateBps,
                    kRecorderMaxBitrateBps);
}

inline uint32_t recorderKeyframeInterval(uint32_t fps) {
  const uint32_t safeFps = fps > 0 ? fps : 30;
  return safeFps * 2u;
}

// Maps elapsed host time to a constant-frame-rate index grid. Small gaps are
// filled in batches of up to four duplicated frames; gaps longer than one
// second jump to the current target index and report a discontinuity.
class RecorderFrameClock {
 public:
  struct Plan {
    uint64_t firstIndex = 0;
    uint32_t count = 0;
    bool discontinuity = false;
  };

  explicit RecorderFrameClock(uint32_t fps) : fps_(fps > 0 ? fps : 30) {}

  Plan plan(uint64_t elapsedNs) {
    const uint64_t target =
        static_cast<uint64_t>(std::llround(
            (static_cast<long double>(elapsedNs) *
             static_cast<long double>(fps_)) /
            1'000'000'000.0L));
    if (target < nextIndex_) {
      pendingFirstIndex_ = nextIndex_;
      return {nextIndex_, 0, false};
    }
    const uint64_t gap = target - nextIndex_ + 1u;
    if (gap > fps_) {
      pendingFirstIndex_ = target;
      return {target, 1, true};
    }
    pendingFirstIndex_ = nextIndex_;
    return {nextIndex_, static_cast<uint32_t>(std::min<uint64_t>(gap, 4u)),
            false};
  }

  void commit(uint32_t written) {
    if (written == 0) {
      return;
    }
    nextIndex_ = pendingFirstIndex_ + written;
  }

 private:
  uint32_t fps_ = 30;
  uint64_t nextIndex_ = 0;
  uint64_t pendingFirstIndex_ = 0;
};

}  // namespace broadify::meeting
