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

// Upper bound for the blocking finalize step in stop() on both platforms
// (AVAssetWriter finishWriting on macOS, IMFSinkWriter::Finalize on Windows).
// When it elapses the recorder reports "finalize_timeout" and keeps the
// ".part" sidecar (REC-03) instead of blocking the sequential control thread
// forever. It MUST stay below the bridge's recording.stop RPC timeout
// (MEETING_HELPER_RPC_TIMEOUTS_MS["recording.stop"] = 20'000 ms in
// apps/bridge/src/services/meeting/meeting-helper-timeouts.ts): a client
// timeout does not cancel the helper-side work, so a larger helper bound
// would make the bridge report failure while the helper still finalizes.
// scripts/meeting-helper-release-contract.test.cjs guards the two values
// against drifting apart.
constexpr int kRecorderFinalizeTimeoutMs = 15'000;

// Audio sample admission relative to the writer session start, shared by the
// platform recorders so the policy is unit-testable without a device.
//
// Default policy (unchanged behaviour): a sample captured BEFORE the session
// start is dropped, a sample at/after it is written with its timestamp
// rebased to the session (t=0 at session start). Both outcomes are counted so
// a mute recording can be diagnosed from the "audio_stats" recorder event and
// the recording status (audio_samples_written / audio_samples_dropped): many
// drops and zero writes means the capture clock ran ahead of the session
// start, zero of both means the device never delivered a sample.
//
// rebase() exposes the raw offset (negative before start) for a later
// behaviour change that clamps early samples instead of dropping them; it is
// deliberately NOT applied by decide() until a Windows measurement justifies
// that change.
class RecorderAudioRebase {
 public:
  struct Decision {
    bool write = false;
    int64_t timestamp = 0;  // rebased sample time, valid when write is true
  };

  static int64_t rebase(int64_t sessionStart, int64_t sampleTimestamp) {
    return sampleTimestamp - sessionStart;
  }

  Decision decide(int64_t sessionStart, int64_t sampleTimestamp) {
    if (sampleTimestamp < sessionStart) {
      ++droppedBeforeStart_;
      return {false, 0};
    }
    ++written_;
    return {true, rebase(sessionStart, sampleTimestamp)};
  }

  void reset() {
    written_ = 0;
    droppedBeforeStart_ = 0;
  }

  uint64_t written() const { return written_; }
  uint64_t droppedBeforeStart() const { return droppedBeforeStart_; }

 private:
  uint64_t written_ = 0;
  uint64_t droppedBeforeStart_ = 0;
};

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
