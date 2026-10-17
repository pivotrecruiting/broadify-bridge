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

// Tiers that run the fused synchronous MODNet session (and therefore have a
// build-time probe and a session cost the program loop pays directly).
bool isFusedTier(GovernorTier tier) {
  return tier == GovernorTier::Full512 || tier == GovernorTier::Balanced320 ||
         tier == GovernorTier::Performance256;
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
  // Lite256 -> Performance256 is not a fused-to-fused move, so the ratio is
  // the area ratio 1.0 (same input size): the async EMA carries over 1:1.
  return emaMs_ * sessionCostRatio(tier_, target);
}

double KeyerAutoGovernor::storedProbeMs(GovernorTier tier) const {
  switch (tier) {
    case GovernorTier::Full512:
      return probe512Ms_;
    case GovernorTier::Balanced320:
      return probe320Ms_;
    case GovernorTier::Performance256:
      return probe256Ms_;
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return -1.0;
  }
  return -1.0;
}

double KeyerAutoGovernor::storedLiveCostMs(GovernorTier tier) const {
  switch (tier) {
    case GovernorTier::Full512:
      return liveCost512Ms_;
    case GovernorTier::Balanced320:
      return liveCost320Ms_;
    case GovernorTier::Performance256:
      return liveCost256Ms_;
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return -1.0;
  }
  return -1.0;
}

void KeyerAutoGovernor::rememberLiveCostOfCurrentTier() {
  // A partial window is too noisy to trust: keep the previous value then.
  if (!config_.measuredCostPolicy || samples_ < config_.minSamples ||
      emaMs_ <= 0.0) {
    return;
  }
  switch (tier_) {
    case GovernorTier::Full512:
      liveCost512Ms_ = emaMs_;
      break;
    case GovernorTier::Balanced320:
      liveCost320Ms_ = emaMs_;
      break;
    case GovernorTier::Performance256:
      liveCost256Ms_ = emaMs_;
      break;
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      break;  // not a fused session cost
  }
}

double KeyerAutoGovernor::sessionCostRatio(GovernorTier from,
                                           GovernorTier to) const {
  const double area = areaScale(to) / areaScale(from);
  // Policy off (BROADIFY_MEETING_OVERRUN_STEPDOWN=always): the historical
  // area ratio everywhere, stored probes are ignored.
  if (!config_.measuredCostPolicy || !isFusedTier(from) || !isFusedTier(to)) {
    return area;
  }
  // 1. Live costs measured on this machine under the current load (the
  //    current tier's EMA once it has a full sample window, else the cost
  //    stored when the governor last left `from`).
  double fromCostMs = (from == tier_ && samples_ >= config_.minSamples)
                          ? emaMs_
                          : storedLiveCostMs(from);
  double toCostMs = storedLiveCostMs(to);
  if (fromCostMs <= 0.0 || toCostMs <= 0.0) {
    // 2. Build-time probes.
    fromCostMs = storedProbeMs(from);
    toCostMs = storedProbeMs(to);
    if (fromCostMs <= 0.0 || toCostMs <= 0.0) {
      // 3. Pixel-area scaling.
      return area;
    }
  }
  const double ratio = toCostMs / fromCostMs;
  if (area <= 1.0) {
    // Step down (to a cheaper input): a smaller tier never costs more than
    // the current one, nor less than the pixel-area scaling predicts.
    return std::min(1.0, std::max(area, ratio));
  }
  // Step up: a larger tier never costs less than the current one, nor more
  // than the pixel-area scaling predicts.
  return std::max(1.0, std::min(area, ratio));
}

bool KeyerAutoGovernor::stepUpBlockedByProgramFrame(GovernorTier target,
                                                    double estimatedMs) const {
  // Only fused -> fused climbs (incl. skips over unavailable tiers): the
  // Lite256 -> Performance256 and Off -> Lite256 paths keep their rules.
  if (!config_.measuredCostPolicy || !isFusedTier(tier_) ||
      !isFusedTier(target) || target == tier_) {
    return false;
  }
  // Unknown program state -> historical behavior.
  if (programFrameEmaMs_ <= 0.0 || programBudgetMs_ <= 0.0) {
    return false;
  }
  // Already over budget at the current tier: the frame is over budget at
  // both tiers, and the measured overrun rule keeps the higher tier.
  if (programFrameEmaMs_ > programBudgetMs_) {
    return false;
  }
  // Extra program-frame cost of the climb: the larger session plus the
  // larger input tensor build.
  const double extraMs =
      std::max(0.0, estimatedMs - emaMs_) +
      std::max(0.0, programTensorMs_) *
          (areaScale(target) / areaScale(tier_) - 1.0);
  // Fits now, would not after the climb: the measured overrun step-down
  // would undo it (a periodic 320 <-> 256 flap). Stay.
  return programFrameEmaMs_ + extraMs > programBudgetMs_;
}

void KeyerAutoGovernor::setProgramFrameState(double programFrameEmaMs,
                                             double budgetMs,
                                             double tensorMs) {
  programFrameEmaMs_ = programFrameEmaMs;
  programBudgetMs_ = budgetMs;
  programTensorMs_ = tensorMs;
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
  if (seeded_ || samples_ > 0u) {
    return;
  }
  // Stored before the 256 guard below, including values <= 0 (= unknown):
  // the session cost ratio falls back to the area ratio for unknown probes.
  probe512Ms_ = full512Ms;
  probe320Ms_ = balanced320Ms;
  probe256Ms_ = performance256Ms;
  if (performance256Ms <= 0.0) {
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
    rememberLiveCostOfCurrentTier();  // no-op for Off, kept for uniformity
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
  if (stepUpBlockedByProgramFrame(availableTierAbove(tier_), estimated)) {
    // The climb would push an in-budget program frame over budget. No state
    // change: no backoff doubling, no clock restart; re-evaluated next frame.
    return;
  }
  if (config_.deferLiteStepUp && tier_ == GovernorTier::Lite256) {
    // Warm handover: do NOT transition yet. The caller warms the fused
    // session in the background (async stays on air) and then commits or
    // cancels. Latched so the decision does not flap while warming.
    liteStepUpPending_ = true;
    return;
  }
  const bool fusedClimb = isFusedTier(tier_);
  rememberLiveCostOfCurrentTier();
  tier_ = availableTierAbove(tier_);
  emaMs_ = -1.0;
  samples_ = 0u;
  degradedAt_ = now;
  stepUpWatch_ = StepUpWatch::Fused;
  if (config_.measuredCostPolicy && fusedClimb) {
    // Start of the overrun wrong-estimate window (measured overload).
    lastFusedStepUpAt_ = now;
    fusedStepUpAtValid_ = true;
  }
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
  rememberLiveCostOfCurrentTier();  // no-op for Lite256, kept for uniformity
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

OverrunOutcome KeyerAutoGovernor::noteProgramBudgetOverrun(
    TimePoint now, const ProgramOverrunSample &sample) {
  OverrunOutcome outcome;
  // Same Ignored cases as the unconditional overload above.
  if (!seeded_) {
    return outcome;
  }
  // Stale sample: the tier moved since the costs were measured (a step-up on
  // the consuming frame, or a sample-driven step-down within the event
  // frame). Its costs describe another tier -> discard, no state change.
  if (sample.tierAtEvent != tier_) {
    return outcome;
  }
  if (tier_ != GovernorTier::Full512 && tier_ != GovernorTier::Balanced320) {
    return outcome;
  }
  const GovernorTier target = availableTierBelow(tier_);
  // Every SteppedDown of this overload goes through here: the wrong-estimate
  // net doubles the step-up holdoff when the step-down comes within
  // overrunWrongEstimateWindow of the last fused -> fused climb. Evaluated
  // BEFORE stepDown(), which consumes the climb; when stepDown()'s own
  // 30-sample watch already doubles for this step-down, the net does not
  // double a second time (one doubling per wrong estimate).
  const auto measuredStepDown = [this, target, now]() {
    const bool watchDoubles = stepUpWatch_ != StepUpWatch::None;
    const bool withinNet = config_.measuredCostPolicy && fusedStepUpAtValid_ &&
                           now - lastFusedStepUpAt_ <=
                               config_.overrunWrongEstimateWindow;
    stepDown(target, now);
    if (withinNet && !watchDoubles) {
      stepUpHoldoff_ = std::min<std::chrono::steady_clock::duration>(
          stepUpHoldoff_ * 2, config_.reprobeMaxInterval);
    }
  };
  if (!isFusedTier(target) || sample.programFrameEmaMs <= 0.0 ||
      sample.budgetMs <= 0.0 || sample.sessionRunMs <= 0.0) {
    // No fused target to project onto, or no usable evidence: keep the
    // unconditional behavior.
    measuredStepDown();
    outcome.decision = OverrunDecision::SteppedDown;
    return outcome;
  }
  // Only the model session and the input tensor build scale with the input
  // size; everything else in the program frame (compositing, readbacks,
  // recorder, preview, VCam) costs the same at the lower tier.
  const double savingsMs =
      sample.sessionRunMs * (1.0 - sessionCostRatio(tier_, target)) +
      std::max(0.0, sample.tensorMs) *
          (1.0 - areaScale(target) / areaScale(tier_));
  const double projectedMs = sample.programFrameEmaMs - savingsMs;
  outcome.estimatedSavingsMs = savingsMs;
  outcome.projectedMs = projectedMs;
  if (projectedMs <= sample.budgetMs) {
    measuredStepDown();
    outcome.decision = OverrunDecision::SteppedDown;
    return outcome;
  }
  // The overrun is not bound to the model resolution: shedding resolution
  // would cost quality without bringing the frame into budget. Leave every
  // piece of state untouched (no EMA/sample reset, no clock restart).
  outcome.decision = OverrunDecision::NotTierBound;
  return outcome;
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
  // Any step-down resolves the last fused climb (like the watch above): the
  // overrun wrong-estimate net can fire at most once per climb.
  fusedStepUpAtValid_ = false;
  rememberLiveCostOfCurrentTier();
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
  probe512Ms_ = -1.0;
  probe320Ms_ = -1.0;
  probe256Ms_ = -1.0;
  programFrameEmaMs_ = -1.0;
  programBudgetMs_ = -1.0;
  programTensorMs_ = -1.0;
  liveCost512Ms_ = -1.0;
  liveCost320Ms_ = -1.0;
  liveCost256Ms_ = -1.0;
  fusedStepUpAtValid_ = false;
  lastFusedStepUpAt_ = TimePoint{};
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
