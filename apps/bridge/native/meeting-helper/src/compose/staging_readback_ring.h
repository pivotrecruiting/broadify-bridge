#pragma once

#include <cstddef>
#include <cstdint>

namespace broadify::meeting {

struct StagingReadbackDecision {
  size_t copyIndex = 0;
  size_t preferredMapIndex = 0;
  size_t fallbackMapIndex = 0;
  bool allowBlockingFallback = false;
};

class StagingReadbackRing {
 public:
  explicit StagingReadbackRing(size_t depth = 3) : depth_(depth < 3 ? 3 : depth) {}

  StagingReadbackDecision advance() {
    StagingReadbackDecision decision;
    decision.copyIndex = frameIndex_ % depth_;
    decision.preferredMapIndex = (frameIndex_ + depth_ - 1u) % depth_;
    decision.fallbackMapIndex = (frameIndex_ + depth_ - 2u) % depth_;
    decision.allowBlockingFallback = frameIndex_ >= 2u;
    ++frameIndex_;
    return decision;
  }

  void reset() { frameIndex_ = 0; }
  size_t frameIndex() const { return frameIndex_; }
  size_t depth() const { return depth_; }

 private:
  size_t depth_ = 3;
  size_t frameIndex_ = 0;
};

}  // namespace broadify::meeting
