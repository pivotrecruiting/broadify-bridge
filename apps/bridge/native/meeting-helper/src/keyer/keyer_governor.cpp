#include "keyer/keyer_governor.h"

#include <algorithm>

namespace broadify::meeting {
namespace {

// Relative inference cost of the lower tiers vs the 512 probe, assuming the
// cost scales ~linearly with input pixel area: (320/512)^2 and (256/512)^2.
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

}  // namespace

KeyerAutoGovernor::KeyerAutoGovernor(const KeyerGovernorConfig &config)
    : config_(config), reprobeInterval_(config.reprobeBaseInterval) {}

double KeyerAutoGovernor::stepDownThresholdMs() const {
  return config_.stepDownOverrideMs > 0.0
             ? config_.stepDownOverrideMs
             : config_.stepDownFactor * config_.frameBudgetMs;
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
  // The re-probe clock starts on the first maybeReprobe() call (seedProbe has
  // no injected time on purpose - the probe median is not an event time).
  degradeClockStarted_ = false;
  probing_ = false;
}

void KeyerAutoGovernor::maybeReprobe(TimePoint now) {
  if (tier_ == GovernorTier::Full512 || probing_) {
    return;
  }
  if (!degradeClockStarted_) {
    // First observation after a seed: start the backoff clock now.
    degradedAt_ = now;
    degradeClockStarted_ = true;
    return;
  }
  if (now - degradedAt_ < reprobeInterval_) {
    return;
  }
  const GovernorTier target = tierAbove(tier_);
  emaMs_ = -1.0;
  samples_ = 0u;
  degradedAt_ = now;
  if (tier_ == GovernorTier::Off) {
    // Off -> Lite256 is accepted without a probe: the async tier produces no
    // fused samples to judge it, and it cannot block the program loop. The
    // (possibly doubled) backoff is kept - climbing further still needs a
    // real probe.
    tier_ = target;
    probing_ = false;
    return;
  }
  tier_ = target;
  probing_ = true;
}

void KeyerAutoGovernor::addSample(double inferenceMs, TimePoint now) {
  if (inferenceMs <= 0.0 || tier_ == GovernorTier::Off) {
    return;
  }
  emaMs_ = emaMs_ < 0.0 ? inferenceMs
                        : config_.emaWeight * inferenceMs +
                              (1.0 - config_.emaWeight) * emaMs_;
  ++samples_;
  const double threshold = stepDownThresholdMs();
  const bool regularExceed = samples_ >= config_.minSamples && emaMs_ > threshold;
  const bool fastExceed = samples_ >= config_.fastStartMinSamples &&
                          emaMs_ > config_.fastStartFactor * threshold;
  if (tier_ == GovernorTier::Lite256) {
    // Bottom active tier: over-budget is expected here (that is why the async
    // worker owns the keyer); only "even async is useless" matters.
    if (samples_ >= config_.minSamples && emaMs_ > config_.offInferenceMs) {
      stepDown(GovernorTier::Off, now);
    }
    return;
  }
  if (regularExceed || fastExceed) {
    stepDown(tierBelow(tier_), now);
    return;
  }
  if (probing_ && samples_ >= config_.stableSamples) {
    // The probe held: this tier is sustainable, so retries stay prompt. The
    // clock restarts so the next climb waits a full base interval.
    reprobeInterval_ = config_.reprobeBaseInterval;
    probing_ = false;
    degradedAt_ = now;
  }
}

void KeyerAutoGovernor::stepDown(GovernorTier target, TimePoint now) {
  tier_ = target;
  emaMs_ = -1.0;
  samples_ = 0u;
  degradedAt_ = now;
  degradeClockStarted_ = true;
  if (probing_) {
    // The probe failed - this machine still cannot hold the better tier, so
    // wait longer before the next retry (doubling, capped) to stop periodic
    // quality wobble (mirrors the Apple governor).
    reprobeInterval_ = std::min<std::chrono::steady_clock::duration>(
        reprobeInterval_ * 2, config_.reprobeMaxInterval);
    probing_ = false;
  }
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
      return "off";
    case GovernorTier::Lite256:
      return "async_lite";
    default:
      return cadenceActive ? "fused_cadence" : "fused";
  }
}

void KeyerAutoGovernor::reset() {
  tier_ = GovernorTier::Full512;
  seeded_ = false;
  emaMs_ = -1.0;
  samples_ = 0u;
  probing_ = false;
  degradeClockStarted_ = false;
  degradedAt_ = TimePoint{};
  reprobeInterval_ = config_.reprobeBaseInterval;
}

}  // namespace broadify::meeting
