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
  // stepDownFactor * frameBudgetMs (mirrors the Apple governor's 34ms@30fps).
  double stepDownFactor = 1.0;
  // Testing override for the step-down threshold: when > 0 it replaces
  // stepDownFactor * frameBudgetMs (BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS).
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
  // Step-up re-probe backoff: base interval, doubled on every failed probe up
  // to the max, reset to base once a probe holds (mirrors the Apple governor).
  std::chrono::steady_clock::duration reprobeBaseInterval =
      std::chrono::seconds(60);
  std::chrono::steady_clock::duration reprobeMaxInterval =
      std::chrono::seconds(600);
  // Consecutive under-threshold samples a probe must survive to count as
  // successful (~1s at 30fps, Apple: 30).
  uint64_t stableSamples = 30u;
};

// Auto-degradation governor for the Windows fused keyer path. Pure logic,
// stdlib only, time injected via steady_clock::time_point parameters; the
// caller (program loop) owns threading. Mirrors the Apple/Vision auto-quality
// governor in keyer_chain.cpp (EMA + hysteresis + doubling re-probe backoff)
// but generalized to a multi-tier ladder with an async and an off tier.
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
  // predicted cost fits the step-down threshold; if not even 256 fits, it
  // seeds Lite256 (async keeps the program loop unblocked), and if the 256
  // estimate exceeds offInferenceMs it seeds Off. No-op once seeded or after
  // samples arrived.
  void seedProbe(double medianWarmupMs);
  bool seeded() const { return seeded_; }

  // Time-driven step-up: once the backoff elapsed, climb one tier and mark it
  // as a probe; addSample() then either confirms (stableSamples under the
  // threshold -> backoff resets to base) or reverts (threshold exceeded ->
  // backoff doubles). Off -> Lite256 is accepted immediately without a probe:
  // the async tier never blocks the program loop, so there is no fused sample
  // stream that could judge it (the backoff is intentionally NOT reset then).
  // Call once per frame before consulting tier().
  void maybeReprobe(TimePoint now);

  // Feeds one successful fused inference cost. Only call for real inference
  // runs (not cadence-reused frames).
  void addSample(double inferenceMs, TimePoint now);

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
  bool probing() const { return probing_; }

 private:
  double stepDownThresholdMs() const;
  void stepDown(GovernorTier target, TimePoint now);

  KeyerGovernorConfig config_{};
  GovernorTier tier_ = GovernorTier::Full512;
  bool seeded_ = false;
  double emaMs_ = -1.0;
  uint64_t samples_ = 0u;
  bool probing_ = false;
  // degradedAt_ is only meaningful while degradeClockStarted_ is true; a bare
  // epoch sentinel would collide with legitimate injected t=0 test clocks.
  bool degradeClockStarted_ = false;
  TimePoint degradedAt_{};
  std::chrono::steady_clock::duration reprobeInterval_ =
      std::chrono::seconds(60);
};

}  // namespace broadify::meeting
