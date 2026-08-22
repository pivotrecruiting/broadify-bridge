#include "keyer/keyer_governor.h"

#include <algorithm>

namespace broadify::meeting {
namespace {

// Relative inference cost of the lower tiers vs the 512 probe, assuming the
// cost scales ~linearly with input pixel area: (320/512)^2 and (256/512)^2.
// Field-validated within ~10% (2026-08: 512/320/256 live measurements).
constexpr double kAreaScale320 = 0.390625;
constexpr double kAreaScale256 = 0.25;

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

// Cost ratio of the tier above the given one relative to it (input pixel-area
// scaling). Lite256 -> Performance256 keeps the input size, so the async EMA
// carries over 1:1.
double stepUpAreaRatio(GovernorTier tier) {
  switch (tier) {
    case GovernorTier::Balanced320:
      return 1.0 / kAreaScale320;               // 320 -> 512: x2.56
    case GovernorTier::Performance256:
      return kAreaScale320 / kAreaScale256;     // 256 -> 320: x1.5625
    case GovernorTier::Lite256:
      return 1.0;                               // async 256 -> fused 256
    case GovernorTier::Full512:
    case GovernorTier::Off:
      return 1.0;                               // no estimate-based step-up
  }
  return 1.0;
}

}  // namespace

KeyerAutoGovernor::KeyerAutoGovernor(const KeyerGovernorConfig &config)
    : config_(config),
      stepUpHoldoff_(config.stepUpMinStableTime),
      reprobeInterval_(config.reprobeBaseInterval) {}

double KeyerAutoGovernor::stepDownThresholdMs() const {
  return config_.stepDownOverrideMs > 0.0
             ? config_.stepDownOverrideMs
             : config_.stepDownFactor * config_.frameBudgetMs;
}

double KeyerAutoGovernor::stepUpThresholdMs() const {
  return std::min(config_.stepUpFactor, 1.0) * stepDownThresholdMs();
}

double KeyerAutoGovernor::estimatedStepUpMs() const {
  if (emaMs_ <= 0.0) {
    return -1.0;
  }
  return emaMs_ * stepUpAreaRatio(tier_);
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
  if (est512 <= threshold) {
    tier_ = GovernorTier::Full512;
  } else if (est320 <= threshold) {
    tier_ = GovernorTier::Balanced320;
  } else if (est256 <= threshold) {
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
  if (full512Ms > 0.0 && full512Ms <= threshold) {
    tier_ = GovernorTier::Full512;
  } else if (balanced320Ms > 0.0 && balanced320Ms <= threshold) {
    tier_ = GovernorTier::Balanced320;
  } else {
    // Build-time probes run while sessions are being created and can be
    // distorted by first-load contention. Never seed below the fused 256 tier
    // from those probes; Lite/Off require live async samples.
    tier_ = GovernorTier::Performance256;
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
  tier_ = tierAbove(tier_);
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
  // Exact semantics of the immediate Lite256 step-up above.
  tier_ = GovernorTier::Performance256;
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
        if (!liteGateClockStarted_) {
          liteGateStartedAt_ = now;
          liteGateClockStarted_ = true;
        }
      } else {
        liteGateOverBudgetSamples_ = 0u;
        liteGateClockStarted_ = false;
      }
    }
    const bool regularExceed =
        samples_ >= config_.minSamples && emaMs_ > threshold;
    const bool fastExceed = samples_ >= config_.fastStartMinSamples &&
                            emaMs_ > config_.fastStartFactor * threshold;
    if (regularExceed || fastExceed) {
      if (config_.tierFirstPolicy && tier_ == GovernorTier::Performance256) {
        const bool sampleGateMet =
            liteGateOverBudgetSamples_ >= config_.liteGateSamples;
        const bool durationGateMet =
            config_.liteGateDuration == std::chrono::steady_clock::duration::zero()
                ? sampleGateMet
                : (liteGateClockStarted_ &&
                   now - liteGateStartedAt_ >= config_.liteGateDuration);
        if (!durationGateMet) {
          return;
        }
      }
      stepDown(tierBelow(tier_), now);
      return;
    }
  }
  if (stepUpWatch_ != StepUpWatch::None && samples_ >= config_.stableSamples) {
    // The stepped-up tier held for a full window: the estimate was right.
    stepUpWatch_ = StepUpWatch::None;
  }
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
  liteGateClockStarted_ = false;
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
  samples_ = 0u;
  liteGateOverBudgetSamples_ = 0u;
  liteGateClockStarted_ = false;
  liteGateStartedAt_ = TimePoint{};
  stepUpWatch_ = StepUpWatch::None;
  degradeClockStarted_ = false;
  degradedAt_ = TimePoint{};
  // Session boundary (user toggled the keyer): learned backoffs restart.
  stepUpHoldoff_ = config_.stepUpMinStableTime;
  reprobeInterval_ = config_.reprobeBaseInterval;
}

}  // namespace broadify::meeting
