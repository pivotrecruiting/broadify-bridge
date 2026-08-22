#include "pipeline/mask_retention.h"

#include <algorithm>

namespace broadify::meeting {

MaskRetention::MaskRetention(const MaskRetentionConfig &config)
    : config_(config) {}

double MaskRetention::effectiveMaxAgeMs(double configuredMaxAgeMs) const {
  const double adaptive =
      intervalEmaMs_ > 0.0 ? config_.retentionFactor * intervalEmaMs_ : 0.0;
  // The gate never exceeds the hard cap, so Apply/StaleHold/Passthrough stay
  // a strict ladder even with a very slow (but healthy) keyer cadence.
  return std::min(std::max(configuredMaxAgeMs, adaptive), config_.hardCapMs);
}

MaskRetentionDecision MaskRetention::decide(uint64_t frameTimestampNs,
                                            uint64_t maskPublishedAtNs,
                                            double maskAgeMs,
                                            double configuredMaxAgeMs,
                                            bool workerAlive) {
  const bool newMask = maskPublishedAtNs != 0u &&
                       maskPublishedAtNs != lastMaskPublishedAtNs_;
  if (newMask) {
    if (lastMaskPublishedAtNs_ != 0u &&
        maskPublishedAtNs > lastMaskPublishedAtNs_) {
      const double intervalMs =
          static_cast<double>(maskPublishedAtNs - lastMaskPublishedAtNs_) /
          1000000.0;
      if (intervalMs > 0.0 && intervalMs <= config_.maxPlausibleIntervalMs) {
        intervalEmaMs_ = intervalEmaMs_ < 0.0
                             ? intervalMs
                             : config_.intervalEmaWeight * intervalMs +
                                   (1.0 - config_.intervalEmaWeight) *
                                       intervalEmaMs_;
      }
    }
    lastMaskPublishedAtNs_ = maskPublishedAtNs;
    // A fresh mask recovers from passthrough immediately (the streak
    // restarts if even the new mask is already beyond the hard cap).
    passthroughActive_ = false;
    overCapFrames_ = 0u;
  }
  // A same-frame re-evaluation must not advance the passthrough streak twice.
  const bool newFrame = frameTimestampNs != lastFrameTimestampNs_;
  lastFrameTimestampNs_ = frameTimestampNs;

  if (maskAgeMs <= effectiveMaxAgeMs(configuredMaxAgeMs)) {
    passthroughActive_ = false;
    overCapFrames_ = 0u;
    return MaskRetentionDecision::Apply;
  }
  if (maskAgeMs <= config_.hardCapMs) {
    overCapFrames_ = 0u;
    return !workerAlive && passthroughActive_ ? MaskRetentionDecision::Passthrough
                                              : MaskRetentionDecision::StaleHold;
  }
  if (workerAlive) {
    passthroughActive_ = true;
    overCapFrames_ = 0u;
    return MaskRetentionDecision::Passthrough;
  }
  if (!workerAlive && passthroughActive_) {
    return MaskRetentionDecision::Passthrough;
  }
  if (newFrame) {
    ++overCapFrames_;
  }
  if (!workerAlive && overCapFrames_ >= config_.passthroughFrames) {
    passthroughActive_ = true;
    return MaskRetentionDecision::Passthrough;
  }
  return MaskRetentionDecision::StaleHold;
}

void MaskRetention::reset() {
  intervalEmaMs_ = -1.0;
  lastMaskPublishedAtNs_ = 0u;
  lastFrameTimestampNs_ = 0u;
  overCapFrames_ = 0u;
  passthroughActive_ = false;
}

}  // namespace broadify::meeting
