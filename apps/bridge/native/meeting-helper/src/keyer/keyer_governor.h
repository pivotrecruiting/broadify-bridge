#pragma once

#include <chrono>
#include <cstdint>

namespace broadify::meeting {

// Quality/effort ladder for the Windows fused MODNet keyer, best first.
// Full512/Balanced320/Performance256 run the fused synchronous path at the
// named MODNet input size; Lite256 hands the keyer to the async worker
// (mask reuse keeps the program at frame rate while inference lags); Off
// stops keying entirely (passthrough) because even async inference is
// uselessly slow.
enum class GovernorTier { Full512, Balanced320, Performance256, Lite256, Off };

struct KeyerGovernorConfig {
  // One program frame of budget (1000/fps). A fused inference above this
  // blocks the program loop below target fps.
  double frameBudgetMs = 1000.0 / 30.0;
  // Step down when the smoothed inference cost exceeds
  // stepDownFactor * frameBudgetMs. A full-frame threshold preserves the
  // rc.12 seed behavior; cadence, not tier churn, handles headroom first.
  double stepDownFactor = 1.0;
  // Testing override for the step-down threshold: when > 0 it replaces
  // stepDownFactor * frameBudgetMs (BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS).
  // It also becomes the base of the step-up threshold, so the hysteresis band
  // stays coherent under the override.
  double stepDownOverrideMs = 0.0;
  // At the bottom active tier (Lite256), a smoothed cost above this means even
  // the async worker's masks arrive too old to be useful -> Off.
  double offInferenceMs = 120.0;
  // Samples required before a regular step-down decision (Apple: 10).
  uint64_t minSamples = 10u;
  // Fast start: a grossly over-budget EMA (> fastStartFactor * threshold)
  // steps down after only fastStartMinSamples, so a hopeless tier does not
  // stall the program loop for a full observation window.
  uint64_t fastStartMinSamples = 3u;
  double fastStartFactor = 2.5;
  // EMA weight of the newest sample (Apple: 0.2).
  double emaWeight = 0.2;
  // Step-UP margin: the next tier's ESTIMATED cost must fit
  // stepUpFactor * stepDownThresholdMs(), so the hysteresis band cannot
  // invert when the step-down threshold is overridden.
  // Field lesson 2026-08-09: live inference under GPU contention can be 2-3x
  // the isolated benchmark, so climbing is only worth a visible transition
  // when the estimate fits with strong margin.
  double stepUpFactor = 0.8;
  // Minimum dwell time at the current tier before an estimate-based step-up
  // is considered. Doubles (up to reprobeMaxInterval) every time a step-up's
  // estimate proves wrong, and never resets downward within a session.
  std::chrono::steady_clock::duration stepUpMinStableTime =
      std::chrono::seconds(10);
  // Off -> Lite256 re-entry backoff: base interval, doubled (up to the max)
  // whenever the re-entry relapses to Off, never reset within a session.
  std::chrono::steady_clock::duration reprobeBaseInterval =
      std::chrono::seconds(60);
  std::chrono::steady_clock::duration reprobeMaxInterval =
      std::chrono::seconds(120);
  // Wrong-estimate watch window: a step-down within this many samples after a
  // step-up counts as a wrong estimate and doubles the corresponding backoff
  // (~1s at 30fps, Apple: 30).
  uint64_t stableSamples = 30u;
  // Windows VCam policy: Teams/encoder contention may push 256 fused over
  // budget transiently. Require a longer consecutive over-budget run before
  // leaving fused for async-lite, and degrade by fused tier first.
  uint64_t liteGateSamples = 30u;
  bool tierFirstPolicy = false;
  // Warm-handover deferral (make-before-break step-up): when true, an
  // estimate-approved Lite256 -> Performance256 step-up does NOT change the
  // tier; the governor latches liteStepUpPending() instead and the caller
  // warms the fused session in the background, then commits via
  // commitLiteStepUp() (or cancels via cancelLiteStepUp() on warmup failure —
  // the wrong-estimate treatment). Default false = the historical immediate
  // step-up (also the BROADIFY_MEETING_WARM_HANDOVER=0 kill-switch path).
  bool deferLiteStepUp = false;
};

// Auto-degradation governor for the Windows fused keyer path. Pure logic,
// stdlib only, time injected via steady_clock::time_point parameters; the
// caller (program loop) owns threading. Mirrors the Apple/Vision auto-quality
// governor in keyer_chain.cpp (EMA + hysteresis) but generalized to a
// multi-tier ladder with an async and an off tier.
//
// Step-UP policy (field fix 2026-08-09): the governor never probes a higher
// tier in the live path. It climbs only when the higher tier's cost ESTIMATE
// (current-tier EMA scaled by the input pixel-area ratio, validated within
// ~10%) fits the frame budget with strong margin (stepUpFactor). A borderline
// machine therefore stays put instead of oscillating through user-visible
// tier changes every backoff interval.
class KeyerAutoGovernor {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  KeyerAutoGovernor() = default;
  explicit KeyerAutoGovernor(const KeyerGovernorConfig &config);

  // Seeds the tier from the session-build warmup probe (median steady-state
  // inference cost measured at the 512 input shape). Heuristic: MODNet
  // inference cost scales roughly linearly with input pixel AREA, so relative
  // to the 512 probe a 320 run costs ~(320/512)^2 = 0.39x and a 256 run
  // ~(256/512)^2 = 0.25x. The governor jumps directly to the best tier whose
  // predicted cost fits the step-down threshold; if not even 256 fits, the
  // measured-probe variant clamps to Performance256 because build-time probes
  // can be distorted by first-load contention. Lite/Off only come from live
  // samples. No-op once seeded or after samples arrived.
  void seedProbe(double medianWarmupMs);
  void seedMeasuredProbes(double full512Ms,
                          double balanced320Ms,
                          double performance256Ms);
  bool seeded() const { return seeded_; }

  // Estimate-based step-up, one tier per step. Fused tiers and Lite256 climb
  // only when (a) at least minSamples were observed at the current tier,
  // (b) at least the step-up holdoff elapsed since the last tier change and
  // (c) the next tier's estimated cost fits stepUpFactor * budget
  // (Lite256 -> Performance256 uses the async-measured EMA directly: same
  // input size). Off -> Lite256 stays time-based (async cannot stall the
  // program loop, and Off produces no samples to estimate from) but never
  // fires faster than the doubling, never-session-reset re-entry backoff.
  // Call once per frame before consulting tier().
  void maybeStepUp(TimePoint now);

  // Feeds one measured inference cost. Fused tiers: only real fused inference
  // runs (not cadence-reused frames). Lite256: the async worker's measured
  // inference cost (basis of the Lite -> Performance256 estimate and of the
  // Lite -> Off guard).
  void addSample(double inferenceMs, TimePoint now);

  // Deferred Lite256 -> Performance256 step-up (config.deferLiteStepUp).
  // Pending means: the estimate approved the step-up, the tier stays Lite256
  // until the caller's warmup resolves. Cleared by any step-down, seed or
  // reset.
  bool liteStepUpPending() const { return liteStepUpPending_; }
  // Commits the deferred step-up after a successful warmup: the tier moves to
  // Performance256 with the exact semantics of the immediate step-up
  // (EMA/sample reset, dwell clock restart, wrong-estimate watch armed).
  // No-op unless pending and still at Lite256.
  void commitLiteStepUp(TimePoint now);
  // Cancels the deferred step-up after a failed warmup. Treated like a wrong
  // estimate: the fused step-up holdoff doubles (capped, never reset within
  // the session) and the dwell clock restarts, so the next attempt backs off.
  // The Lite EMA/samples survive — they are real async measurements.
  void cancelLiteStepUp(TimePoint now);

  GovernorTier tier() const { return tier_; }
  // MODNet performanceMode string for the current tier. Lite256/Off also map
  // to "performance": if the fused path runs anyway, smallest input applies.
  const char *performanceModeForTier() const;
  bool wantsAsyncLite() const { return tier_ == GovernorTier::Lite256; }
  bool wantsOff() const { return tier_ == GovernorTier::Off; }
  // Status label for the bridge ("keyer_pipeline_mode"). Whether the fused
  // tier is currently frame-skipping ("fused_cadence") is the cadence
  // controller's knowledge, so the caller passes it in.
  const char *pipelineModeLabel(bool cadenceActive) const;

  void reset();

  // Introspection for tests/telemetry.
  double inferenceEmaMs() const { return emaMs_; }
  std::chrono::steady_clock::duration reprobeInterval() const {
    return reprobeInterval_;
  }
  std::chrono::steady_clock::duration stepUpHoldoff() const {
    return stepUpHoldoff_;
  }

 private:
  // Which backoff to double if the tier falls back within stableSamples of
  // the step-up that reached it (= the step-up estimate proved wrong).
  enum class StepUpWatch { None, Fused, OffReentry };

  double stepDownThresholdMs() const;
  double stepUpThresholdMs() const;
  // Estimated cost of the tier ABOVE the current one, scaled from the
  // current-tier EMA by the input pixel-area ratio (< 0 when no EMA exists).
  double estimatedStepUpMs() const;
  void stepDown(GovernorTier target, TimePoint now);

  KeyerGovernorConfig config_{};
  GovernorTier tier_ = GovernorTier::Full512;
  bool seeded_ = false;
  bool liteStepUpPending_ = false;
  double emaMs_ = -1.0;
  uint64_t samples_ = 0u;
  uint64_t liteGateOverBudgetSamples_ = 0u;
  StepUpWatch stepUpWatch_ = StepUpWatch::None;
  // degradedAt_ is only meaningful while degradeClockStarted_ is true; a bare
  // epoch sentinel would collide with legitimate injected t=0 test clocks.
  bool degradeClockStarted_ = false;
  TimePoint degradedAt_{};
  std::chrono::steady_clock::duration stepUpHoldoff_ =
      std::chrono::seconds(10);
  std::chrono::steady_clock::duration reprobeInterval_ =
      std::chrono::seconds(60);
};

}  // namespace broadify::meeting
