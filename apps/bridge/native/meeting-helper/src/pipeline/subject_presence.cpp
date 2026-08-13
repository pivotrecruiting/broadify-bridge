#include "pipeline/subject_presence.h"

namespace broadify::meeting {

SubjectPresenceTracker::SubjectPresenceTracker(
    const SubjectPresenceConfig &config)
    : config_(config) {}

SubjectPresence SubjectPresenceTracker::feed(double coverage,
                                             bool inferenceSucceeded,
                                             double nowMs) {
  if (!inferenceSucceeded) {
    // Dropout: freeze the streak clock (the failure gap must not count
    // towards the acceptance time) but keep an already confirmed absence -
    // a failing model is no evidence that the person returned.
    hasAnchor_ = false;
    return confirmed_ ? SubjectPresence::ConfirmedEmpty
                      : SubjectPresence::BridgingDropout;
  }
  if (coverage >= config_.emptyAcceptCoverage) {
    // Re-entry: one confident frame immediately resets to Present.
    streakActive_ = false;
    hasAnchor_ = false;
    accumulatedMs_ = 0.0;
    confirmed_ = false;
    return SubjectPresence::Present;
  }
  if (!config_.enabled) {
    // Inert (kill-switch): below-floor frames stay classified as dropouts.
    return SubjectPresence::BridgingDropout;
  }
  if (!streakActive_) {
    streakActive_ = true;
    accumulatedMs_ = 0.0;
  } else if (hasAnchor_ && nowMs > anchorMs_) {
    accumulatedMs_ += nowMs - anchorMs_;
  }
  hasAnchor_ = true;
  anchorMs_ = nowMs;
  if (accumulatedMs_ >= config_.acceptAfterMs) {
    confirmed_ = true;
  }
  return confirmed_ ? SubjectPresence::ConfirmedEmpty
                    : SubjectPresence::BridgingDropout;
}

void SubjectPresenceTracker::reset() {
  streakActive_ = false;
  hasAnchor_ = false;
  anchorMs_ = 0.0;
  accumulatedMs_ = 0.0;
  confirmed_ = false;
}

}  // namespace broadify::meeting
