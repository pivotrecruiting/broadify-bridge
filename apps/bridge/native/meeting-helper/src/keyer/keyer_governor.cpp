#include "keyer/keyer_governor.h"

#include <algorithm>

namespace broadify::meeting {
namespace {

// Relative inference cost of the lower tiers vs the 512 probe, assuming the
// cost scales ~linearly with input pixel area: (320/512)^2 and (256/512)^2.
// Field-validated within ~10% (2026-08: 512/320/256 live measurements).
constexpr double kAreaScale320 = 0.390625;
constexpr double kAreaScale256 = 0.25;
constexpr double kOverheadFloorFactor = 0.5;

GovernorTier tierBelow(GovernorTier tier) {
  switch (tier) {
    case GovernorTier::Full512:
      return GovernorTier::Balanced320;
    case GovernorTier::Balanced320:
      return GovernorTier::Performance256;
    case GovernorTier::Performance256:
      return GovernorTier::Lite256;
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return GovernorTier::Off;
  }
  return GovernorTier::Off;
}

GovernorTier tierAbove(GovernorTier tier) {
  switch (tier) {
    case GovernorTier::Off:
      return GovernorTier::Lite256;
    case GovernorTier::Lite256:
      return GovernorTier::Performance256;
    case GovernorTier::Performance256:
      return GovernorTier::Balanced320;
    case GovernorTier::Balanced320:
    case GovernorTier::Full512:
      return GovernorTier::Full512;
  }
  return GovernorTier::Full512;
}

// Input pixel-area of a tier relative to the 512 shape. Lite256 runs the
// same 256 input as Performance256 (async vs fused), so the async EMA
// carries over 1:1 on that step. Any step-up ratio — including skips over an
// unavailable tier, e.g. 256 -> 512 = x4 — is areaScale(target)/areaScale(from).
double areaScale(GovernorTier tier) {
  switch (tier) {
    case GovernorTier::Full512:
      return 1.0;
    case GovernorTier::Balanced320:
      return kAreaScale320;
    case GovernorTier::Performance256:
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return kAreaScale256;
  }
  return kAreaScale256;
}

}  // namespace

KeyerAutoGovernor::KeyerAutoGovernor(const KeyerGovernorConfig &config)
    : config_(config),
      stepUpHoldoff_(config.stepUpMinStableTime),
      reprobeInterval_(config.reprobeBaseInterval) {}

void KeyerAutoGovernor::setFusedTierAvailability(bool full512,
                                                 bool balanced320,
                                                 bool performance256) {
  full512Available_ = full512;
  balanced320Available_ = balanced320;
  performance256Available_ = performance256;
}

bool KeyerAutoGovernor::tierAvailable(GovernorTier tier) const {
  switch (tier) {
    case GovernorTier::Full512:
      return full512Available_;
    case GovernorTier::Balanced320:
      return balanced320Available_;
    case GovernorTier::Performance256:
      return performance256Available_;
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return true;
  }
  return true;
}

GovernorTier KeyerAutoGovernor::availableTierBelow(GovernorTier tier) const {
  GovernorTier below = tierBelow(tier);
  while (below != GovernorTier::Off && !tierAvailable(below)) {
    below = tierBelow(below);
  }
  return below;
}

GovernorTier KeyerAutoGovernor::availableTierAbove(GovernorTier tier) const {
  GovernorTier above = tierAbove(tier);
  while (!tierAvailable(above)) {
    const GovernorTier next = tierAbove(above);
    if (next == above) {
      // Topmost tier reached but unavailable: nothing to climb to.
      return tier;
    }
    above = next;
  }
  return above == tier ? tier : above;
}

double KeyerAutoGovernor::stepDownThresholdMs() const {
  if (config_.stepDownOverrideMs > 0.0) {
    return config_.stepDownOverrideMs;
  }
  const double base = config_.stepDownFactor * config_.frameBudgetMs;
  return std::max(kOverheadFloorFactor * base, base - frameOverheadMs_);
}

double KeyerAutoGovernor::stepUpThresholdMs() const {
  return std::min(config_.stepUpFactor, 1.0) * stepDownThresholdMs();
}

double KeyerAutoGovernor::estimatedStepUpMs() const {
  if (emaMs_ <= 0.0) {
    return -1.0;
  }
  const GovernorTier target = availableTierAbove(tier_);
  if (target == tier_) {
    return -1.0;
  }
  return emaMs_ * (areaScale(target) / areaScale(tier_));
}

void KeyerAutoGovernor::seedProbe(double medianWarmupMs) {
  if (seeded_ || samples_ > 0u || medianWarmupMs <= 0.0) {
    return;
  }
  seeded_ = true;
  const double threshold = stepDownThresholdMs();
  const double est512 = medianWarmupMs;
  const double est320 = medianWarmupMs * kAreaScale320;
  const double est256 = medianWarmupMs * kAreaScale256;
  if (est512 <= threshold && full512Available_) {
    tier_ = GovernorTier::Full512;
  } else if (est320 <= threshold && balanced320Available_) {
    tier_ = GovernorTier::Balanced320;
  } else if (est256 <= threshold && performance256Available_) {
    tier_ = GovernorTier::Performance256;
  } else if (est256 <= config_.offInferenceMs) {
    tier_ = GovernorTier::Lite256;
  } else {
    tier_ = GovernorTier::Off;
  }
  // The step-up clock starts on the first maybeStepUp() call (seedProbe has
  // no injected time on purpose - the probe median is not an event time).
  degradeClockStarted_ = false;
  stepUpWatch_ = StepUpWatch::None;
  liteStepUpPending_ = false;
}

void KeyerAutoGovernor::seedMeasuredProbes(double full512Ms,
                                           double balanced320Ms,
                                           double performance256Ms) {
  if (seeded_ || samples_ > 0u || performance256Ms <= 0.0) {
    return;
  }
  seeded_ = true;
  const double threshold = stepUpThresholdMs();
  if (full512Ms > 0.0 && full512Available_ && full512Ms <= threshold) {
    tier_ = GovernorTier::Full512;
  } else if (balanced320Ms > 0.0 && balanced320Available_ &&
             balanced320Ms <= threshold) {
    tier_ = GovernorTier::Balanced320;
  } else if (performance256Available_) {
    // Build-time probes run while sessions are being created and can be
    // distorted by first-load contention. Never seed below the fused 256 tier
    // from those probes; Lite/Off require live async samples.
    tier_ = GovernorTier::Performance256;
  } else {
    // No fused 256 session (exotic prebuild config): seed to the lowest
    // available fused tier, or Lite256 when none exists at all.
    tier_ = availableTierAbove(GovernorTier::Lite256);
  }
  degradeClockStarted_ = false;
  stepUpWatch_ = StepUpWatch::None;
  liteStepUpPending_ = false;
}

void KeyerAutoGovernor::maybeStepUp(TimePoint now) {
  if (tier_ == GovernorTier::Full512) {
    return;
  }
  if (liteStepUpPending_) {
    // A deferred step-up is already awaiting its warmup result; nothing to
    // re-evaluate until the caller commits or cancels it.
    return;
  }
  if (!degradeClockStarted_) {
    // First observation after a seed: start the holdoff clock now.
    degradedAt_ = now;
    degradeClockStarted_ = true;
    return;
  }
  if (tier_ == GovernorTier::Off) {
    // Off -> Lite256 stays purely time-based: the async tier cannot block the
    // program loop, and Off produces no samples to estimate from. Every
    // Lite -> Off relapse doubled the backoff (stepDown), and it never resets
    // within a session, so a hopeless machine converges to rare retries.
    if (now - degradedAt_ < reprobeInterval_) {
      return;
    }
    tier_ = GovernorTier::Lite256;
    emaMs_ = -1.0;
    samples_ = 0u;
    degradedAt_ = now;
    stepUpWatch_ = StepUpWatch::OffReentry;
    return;
  }
  // Estimate-based step-up: NO live probe. Climb only when the higher tier's
  // predicted cost fits the budget with strong margin, after enough samples
  // and dwell time at the current tier.
  if (now - degradedAt_ < stepUpHoldoff_) {
    return;
  }
  if (samples_ < config_.minSamples) {
    return;
  }
  const double estimated = estimatedStepUpMs();
  if (estimated < 0.0 || estimated > stepUpThresholdMs()) {
    return;
  }
  if (config_.deferLiteStepUp && tier_ == GovernorTier::Lite256) {
    // Warm handover: do NOT transition yet. The caller warms the fused
    // session in the background (async stays on air) and then commits or
    // cancels. Latched so the decision does not flap while warming.
    liteStepUpPending_ = true;
    return;
  }
  tier_ = availableTierAbove(tier_);
  emaMs_ = -1.0;
  samples_ = 0u;
  degradedAt_ = now;
  stepUpWatch_ = StepUpWatch::Fused;
}

void KeyerAutoGovernor::commitLiteStepUp(TimePoint now) {
  if (!liteStepUpPending_ || tier_ != GovernorTier::Lite256) {
    liteStepUpPending_ = false;
    return;
  }
  liteStepUpPending_ = false;
  // Exact semantics of the immediate Lite256 step-up above; the target is
  // the lowest available fused tier (Performance256 in every default config).
  const GovernorTier target = availableTierAbove(GovernorTier::Lite256);
  if (target == GovernorTier::Lite256) {
    return;  // no fused session available at all — stay async.
  }
  tier_ = target;
  emaMs_ = -1.0;
  samples_ = 0u;
  degradedAt_ = now;
  degradeClockStarted_ = true;
  stepUpWatch_ = StepUpWatch::Fused;
}

void KeyerAutoGovernor::cancelLiteStepUp(TimePoint now) {
  const bool wasPending = liteStepUpPending_ && tier_ == GovernorTier::Lite256;
  liteStepUpPending_ = false;
  if (!wasPending) {
    return;
  }
  // Warmup failure == the estimate proved wrong before we ever cut over:
  // apply the same persistent backoff doubling a post-step-up relapse would,
  // and restart the dwell clock so the doubled holdoff actually gates the
  // next attempt (EMA/samples survive — they are real async measurements).
  stepUpHoldoff_ = std::min<std::chrono::steady_clock::duration>(
      stepUpHoldoff_ * 2, config_.reprobeMaxInterval);
  degradedAt_ = now;
  degradeClockStarted_ = true;
}

void KeyerAutoGovernor::addSample(double inferenceMs, TimePoint now) {
  if (inferenceMs <= 0.0 || tier_ == GovernorTier::Off) {
    return;
  }
  emaMs_ = emaMs_ < 0.0 ? inferenceMs
                        : config_.emaWeight * inferenceMs +
                              (1.0 - config_.emaWeight) * emaMs_;
  ++samples_;
  if (tier_ == GovernorTier::Lite256) {
    // Bottom active tier: over-budget is expected here (that is why the async
    // worker owns the keyer); only "even async is useless" matters.
    if (samples_ >= config_.minSamples && emaMs_ > config_.offInferenceMs) {
      stepDown(GovernorTier::Off, now);
      return;
    }
  } else {
    const double threshold = stepDownThresholdMs();
    if (config_.tierFirstPolicy && tier_ == GovernorTier::Performance256) {
      if (inferenceMs > threshold) {
        ++liteGateOverBudgetSamples_;
      } else {
        liteGateOverBudgetSamples_ = 0u;
      }
    }
    const bool regularExceed =
        samples_ >= config_.minSamples && emaMs_ > threshold;
    const bool fastExceed = samples_ >= config_.fastStartMinSamples &&
                            emaMs_ > config_.fastStartFactor * threshold;
    if (regularExceed || fastExceed) {
      if (config_.tierFirstPolicy && tier_ == GovernorTier::Performance256) {
        if (liteGateOverBudgetSamples_ < config_.liteGateSamples) {
          return;
        }
      }
      stepDown(availableTierBelow(tier_), now);
      return;
    }
  }
  if (stepUpWatch_ != StepUpWatch::None && samples_ >= config_.stableSamples) {
    // The stepped-up tier held for a full window: the estimate was right.
    stepUpWatch_ = StepUpWatch::None;
  }
}

void KeyerAutoGovernor::setFrameOverheadMs(double overheadMs) {
  frameOverheadMs_ = std::max(0.0, overheadMs);
}

void KeyerAutoGovernor::noteProgramBudgetOverrun(TimePoint now) {
  if (!seeded_) {
    return;
  }
  // Only shed load by resolution from the upper fused tiers; the descent into
  // Lite/Off is the sample-driven liteGate policy's job, not this trigger's.
  if (tier_ != GovernorTier::Full512 && tier_ != GovernorTier::Balanced320) {
    return;
  }
  stepDown(availableTierBelow(tier_), now);
}

void KeyerAutoGovernor::stepDown(GovernorTier target, TimePoint now) {
  // Any step-down invalidates a deferred (not yet committed) step-up.
  liteStepUpPending_ = false;
  if (stepUpWatch_ != StepUpWatch::None) {
    // A step-down within stableSamples of the last step-up means the estimate
    // proved wrong: double the backoff of THAT step-up path, persistently for
    // the session (never reset downward), so the visible wobble cannot repeat
    // at a fixed period.
    if (stepUpWatch_ == StepUpWatch::OffReentry) {
      reprobeInterval_ = std::min<std::chrono::steady_clock::duration>(
          reprobeInterval_ * 2, config_.reprobeMaxInterval);
    } else {
      stepUpHoldoff_ = std::min<std::chrono::steady_clock::duration>(
          stepUpHoldoff_ * 2, config_.reprobeMaxInterval);
    }
    stepUpWatch_ = StepUpWatch::None;
  }
  tier_ = target;
  emaMs_ = -1.0;
  samples_ = 0u;
  liteGateOverBudgetSamples_ = 0u;
  degradedAt_ = now;
  degradeClockStarted_ = true;
}

const char *KeyerAutoGovernor::performanceModeForTier() const {
  switch (tier_) {
    case GovernorTier::Full512:
      return "high_quality";
    case GovernorTier::Balanced320:
      return "balanced";
    case GovernorTier::Performance256:
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return "performance";
  }
  return "performance";
}

const char *KeyerAutoGovernor::pipelineModeLabel(bool cadenceActive) const {
  switch (tier_) {
    case GovernorTier::Off:
      return "off_reduced";
    case GovernorTier::Lite256:
      return "async_lite";
    default:
      return cadenceActive ? "fused_cadence" : "fused";
  }
}

void KeyerAutoGovernor::reset() {
  tier_ = GovernorTier::Full512;
  seeded_ = false;
  liteStepUpPending_ = false;
  emaMs_ = -1.0;
  frameOverheadMs_ = 0.0;
  samples_ = 0u;
  liteGateOverBudgetSamples_ = 0u;
  stepUpWatch_ = StepUpWatch::None;
  degradeClockStarted_ = false;
  degradedAt_ = TimePoint{};
  // Session boundary (user toggled the keyer): learned backoffs restart.
  stepUpHoldoff_ = config_.stepUpMinStableTime;
  reprobeInterval_ = config_.reprobeBaseInterval;
}

}  // namespace broadify::meeting
