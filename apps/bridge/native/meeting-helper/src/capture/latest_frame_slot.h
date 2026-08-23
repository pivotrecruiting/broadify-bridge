#pragma once

#include "capture/camera_source.h"

#include <utility>

namespace broadify::meeting {

class LatestFrameSlot {
 public:
  void publish(VideoFrame &&frame) {
    std::swap(latestFrame_, frame);
    latestPublishedTimestampNs_ = latestFrame_.timestampNs;
    hasFrame_ = true;
  }

  bool takeIfNew(uint64_t lastTimestampNs, VideoFrame &frame) {
    if (!hasFrame_ || latestPublishedTimestampNs_ == lastTimestampNs ||
        latestPublishedTimestampNs_ == latestTakenTimestampNs_) {
      return false;
    }
    std::swap(frame, latestFrame_);
    latestTakenTimestampNs_ = latestPublishedTimestampNs_;
    return true;
  }

  bool copyIfNew(uint64_t lastTimestampNs, VideoFrame &frame) const {
    if (!hasFrame_ || latestPublishedTimestampNs_ == lastTimestampNs ||
        latestPublishedTimestampNs_ == latestTakenTimestampNs_) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

  bool copy(VideoFrame &frame) const {
    if (!hasFrame_) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

  bool hasFrame() const { return hasFrame_; }

  bool hasFrameNewerThan(uint64_t lastTimestampNs) const {
    return hasFrame_ && latestPublishedTimestampNs_ != lastTimestampNs &&
           latestPublishedTimestampNs_ != latestTakenTimestampNs_;
  }

 private:
  bool hasFrame_ = false;
  uint64_t latestPublishedTimestampNs_ = 0u;
  uint64_t latestTakenTimestampNs_ = 0u;
  VideoFrame latestFrame_;
};

}  // namespace broadify::meeting
