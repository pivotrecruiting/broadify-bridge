#include "pipeline/tier_handover.h"

namespace broadify::meeting {

bool TierHandover::beginWarmup(TimePoint now) {
  (void)now;
  if (phase_ != Phase::Idle) {
    return false;
  }
  phase_ = Phase::Warming;
  warmupSucceededPending_ = false;
  warmupFailedPending_ = false;
  return true;
}

void TierHandover::completeWarmup(bool success) {
  if (phase_ != Phase::Warming) {
    return;
  }
  phase_ = Phase::Idle;
  warmupSucceededPending_ = success;
  warmupFailedPending_ = !success;
}

bool TierHandover::consumeWarmupSuccess() {
  if (!warmupSucceededPending_) {
    return false;
  }
  warmupSucceededPending_ = false;
  return true;
}

bool TierHandover::consumeWarmupFailure() {
  if (!warmupFailedPending_) {
    return false;
  }
  warmupFailedPending_ = false;
  return true;
}

bool TierHandover::beginOverlap(uint64_t nowNs, TimePoint now) {
  if (phase_ != Phase::Idle) {
    return false;
  }
  phase_ = Phase::Overlap;
  overlapStartNs_ = nowNs;
  overlapStartedAt_ = now;
  return true;
}

bool TierHandover::cutoverDue(uint64_t latestPairPublishedAtNs,
                              TimePoint now) const {
  if (phase_ != Phase::Overlap) {
    return false;
  }
  if (pairArrivedSinceOverlapStart(latestPairPublishedAtNs)) {
    return true;
  }
  return now - overlapStartedAt_ >= config_.maxStepDownOverlap;
}

bool TierHandover::pairArrivedSinceOverlapStart(
    uint64_t latestPairPublishedAtNs) const {
  // A pair published BEFORE the overlap began is the previous async epoch's
  // (stale) output — only a pair the worker produced after the transition
  // start proves the async path is warm.
  return latestPairPublishedAtNs != 0u &&
         latestPairPublishedAtNs >= overlapStartNs_;
}

void TierHandover::finishOverlap() {
  if (phase_ != Phase::Overlap) {
    return;
  }
  phase_ = Phase::Idle;
  overlapStartNs_ = 0u;
  overlapStartedAt_ = TimePoint{};
}

void TierHandover::reset() {
  phase_ = Phase::Idle;
  warmupSucceededPending_ = false;
  warmupFailedPending_ = false;
  overlapStartNs_ = 0u;
  overlapStartedAt_ = TimePoint{};
}

}  // namespace broadify::meeting
