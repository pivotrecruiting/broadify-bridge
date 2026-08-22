#include "pipeline/ofd_temporal.h"

#include <algorithm>
#include <cstddef>
#include <cstdlib>

namespace broadify::meeting {
namespace {

uint8_t meanByte(uint8_t a, uint8_t b) {
  return static_cast<uint8_t>((static_cast<unsigned>(a) +
                               static_cast<unsigned>(b) + 1u) /
                              2u);
}

bool sameMaskShape(const AlphaMask &a, const AlphaMask &b) {
  return a.width == b.width && a.height == b.height &&
         a.alpha.size() == b.alpha.size() && a.width != 0u &&
         a.height != 0u && !a.alpha.empty();
}

}  // namespace

OfdTemporal::OfdTemporal(OfdConfig config) : config_(config) {}

bool OfdTemporal::push(const AlphaMask &input, AlphaMask &output) {
  if (input.width == 0u || input.height == 0u || input.alpha.empty()) {
    reset();
    return false;
  }
  if (!hasPrevious_) {
    previous_ = input;
    hasPrevious_ = true;
    return false;
  }
  if (!sameMaskShape(previous_, input)) {
    previous_ = input;
    middle_ = AlphaMask{};
    hasMiddle_ = false;
    return false;
  }
  if (!hasMiddle_) {
    middle_ = input;
    hasMiddle_ = true;
    return false;
  }
  if (!sameMaskShape(middle_, input)) {
    previous_ = input;
    middle_ = AlphaMask{};
    hasMiddle_ = false;
    return false;
  }
  finalizeMiddle(input, middle_);
  output = middle_;
  previous_ = middle_;
  middle_ = input;
  return true;
}

void OfdTemporal::reset() {
  previous_ = AlphaMask{};
  middle_ = AlphaMask{};
  hasPrevious_ = false;
  hasMiddle_ = false;
}

void OfdTemporal::configure(OfdConfig config) {
  if (config.epsilonNear == config_.epsilonNear &&
      config.epsilonFar == config_.epsilonFar) {
    return;
  }
  config_ = config;
  reset();
}

void OfdTemporal::finalizeMiddle(const AlphaMask &next, AlphaMask &middle) const {
  for (size_t i = 0; i < middle.alpha.size(); ++i) {
    const int prev = previous_.alpha[i];
    const int cur = middle.alpha[i];
    const int future = next.alpha[i];
    if (std::abs(prev - future) < config_.epsilonNear &&
        std::abs(cur - prev) > config_.epsilonFar &&
        std::abs(cur - future) > config_.epsilonFar) {
      middle.alpha[i] = meanByte(previous_.alpha[i], next.alpha[i]);
    }
  }
}

}  // namespace broadify::meeting
