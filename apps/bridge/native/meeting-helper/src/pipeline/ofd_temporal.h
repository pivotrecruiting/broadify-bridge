#pragma once

#include "keyer/keyer.h"

#include <cstdint>
#include <deque>
#include <memory>

namespace broadify::meeting {

struct OfdConfig {
  uint8_t epsilonNear = 8;
  uint8_t epsilonFar = 24;
};

class OfdTemporal {
 public:
  explicit OfdTemporal(OfdConfig config = {});

  bool push(const AlphaMask &input, AlphaMask &output);
  void reset();
  void configure(OfdConfig config);
  uint64_t delayFrames() const { return 1u; }

 private:
  void finalizeMiddle(const AlphaMask &next, AlphaMask &middle) const;

  OfdConfig config_;
  AlphaMask previous_;
  AlphaMask middle_;
  bool hasPrevious_ = false;
  bool hasMiddle_ = false;
};

class OfdFrameDelayQueue {
 public:
  bool push(const std::shared_ptr<const VideoFrame> &frame,
            std::shared_ptr<const VideoFrame> &delayed);
  void reset();

 private:
  std::deque<std::shared_ptr<const VideoFrame>> frames_;
};

}  // namespace broadify::meeting
