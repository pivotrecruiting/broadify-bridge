#pragma once

#include "capture/latest_frame_slot.h"

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <utility>

namespace broadify::meeting {

class GuardedFrameSlot {
 public:
  VideoFrame &scratch() { return scratch_; }

  void publish() { publish(std::move(scratch_)); }

  void publish(VideoFrame &&frame) {
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      latestFrameSlot_.publish(std::move(frame));
    }
    frameCv_.notify_all();
  }

  bool copyLatest(VideoFrame &frame) const {
    std::lock_guard<std::mutex> lock(frameMutex_);
    return latestFrameSlot_.copy(frame);
  }

  bool copyIfNew(uint64_t lastTimestampNs, VideoFrame &frame) const {
    std::lock_guard<std::mutex> lock(frameMutex_);
    return latestFrameSlot_.copyIfNew(lastTimestampNs, frame);
  }

  bool takeIfNew(uint64_t lastTimestampNs, VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(frameMutex_);
    return latestFrameSlot_.takeIfNew(lastTimestampNs, frame);
  }

  bool waitForNewerThan(uint64_t lastTimestampNs,
                        std::chrono::steady_clock::time_point deadline) {
    std::unique_lock<std::mutex> lock(frameMutex_);
    return frameCv_.wait_until(lock, deadline, [this, lastTimestampNs] {
      return latestFrameSlot_.hasFrameNewerThan(lastTimestampNs);
    });
  }

  bool hasFrame() const {
    std::lock_guard<std::mutex> lock(frameMutex_);
    return latestFrameSlot_.hasFrame();
  }

 private:
  mutable std::mutex frameMutex_;
  std::condition_variable frameCv_;
  LatestFrameSlot latestFrameSlot_;
  VideoFrame scratch_;
};

}  // namespace broadify::meeting
