#pragma once

#include "keyer/keyer.h"

#include <cstdint>

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
  uint64_t delayFrames() const { return 1u; }

 private:
  void finalizeMiddle(const AlphaMask &next, AlphaMask &middle) const;

  OfdConfig config_;
  AlphaMask previous_;
  AlphaMask middle_;
  bool hasPrevious_ = false;
  bool hasMiddle_ = false;
};

}  // namespace broadify::meeting
