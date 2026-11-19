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
  // Measured-cost policy (2026-10-17, default true): session cost ratios use
  // live per-tier session costs, else the stored build-time probes (both
  // clamped); fused -> fused step-ups are guarded against climbs that would
  // push an in-budget program frame over budget (setProgramFrameState); and a
  // measured overrun step-down soon after a fused climb counts as a wrong
  // estimate (overrunWrongEstimateWindow). false = full rollback to the
  // historical behavior: area ratios everywhere, no live-cost memory, no
  // program-frame step-up guard, no overrun wrong-estimate net
  // (BROADIFY_MEETING_OVERRUN_STEPDOWN=always).
  bool measuredCostPolicy = true;
  // Wrong-estimate net for measured overrun step-downs (measuredCostPolicy
  // only): a SteppedDown from the measured noteProgramBudgetOverrun()
  // overload within this window after the last fused -> fused step-up
  // doubles the step-up holdoff like the existing wrong-estimate doubling.
  // The existing 30-sample watch cannot see these step-downs: the overrun
  // reporter only fires every ~10 s.
  std::chrono::steady_clock::duration overrunWrongEstimateWindow =
      std::chrono::seconds(30);
};

// Evidence of one sustained program-loop budget overrun, taken from the SAME
// program frame that confirmed it (BudgetOverrunReporter). A value <= 0 means
// "unknown" (tensorMs < 0 counts as 0).
struct ProgramOverrunSample {
  double programFrameEmaMs = -1.0;
  double budgetMs = -1.0;
  double sessionRunMs = -1.0;
  double tensorMs = -1.0;
  // Governor tier the sample's costs were measured at (the event frame's
  // fused inference). The sample is consumed one frame later; if the tier
  // moved in between, the costs belong to another tier and the sample is
  // stale -> Ignored. Default Off = untagged: Off never matches an upper
  // fused tier, so an untagged sample can never step down.
  GovernorTier tierAtEvent = GovernorTier::Off;
};

// Ignored: no step-down possible/allowed (not seeded, stale sample, or not
// an upper fused tier). SteppedDown: the tier moved one available tier down.
// NotTierBound: the measured-cost projection says the lower tier cannot bring
// the program frame into budget, so the tier (and all governor state) stayed
// unchanged.
enum class OverrunDecision { Ignored, SteppedDown, NotTierBound };

struct OverrunOutcome {
  OverrunDecision decision = OverrunDecision::Ignored;
  // Projection inputs/outputs; -1 when the decision did not use the
  // measured-cost projection (Ignored, invalid sample, non-fused target).
  double estimatedSavingsMs = -1.0;
  double projectedMs = -1.0;
};

// Auto-degradation governor for the Windows fused keyer path. Pure logic,
// stdlib only, time injected via steady_clock::time_point parameters; the
// caller (program loop) owns threading. Mirrors the Apple/Vision auto-quality
// governor in keyer_chain.cpp (EMA + hysteresis) but generalized to a
// multi-tier ladder with an async and an off tier.
//
// Step-UP policy (field fix 2026-08-09): the governor never probes a higher
// tier in the live path. It climbs only when the higher tier's cost ESTIMATE
// fits the frame budget with strong margin (stepUpFactor). The estimate is
// the current-tier EMA scaled by the session cost ratio (sessionCostRatio):
// with measuredCostPolicy (default) the live per-tier session costs
// remembered when the governor last left a tier, else the build-time probe
// ratio, else the input pixel-area ratio - clamped to [1, area ratio].
// Fused -> fused climbs additionally pass the program-frame guard
// (setProgramFrameState): a climb that would push an in-budget program frame
// over budget is not taken. measuredCostPolicy = false (the "always" mode)
// restores the pure area-ratio estimate without guard. A borderline machine
// therefore stays put instead of oscillating through user-visible tier
// changes every backoff interval.
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
  // seedMeasuredProbes() additionally stores the three probes (<= 0 =
  // unknown) whenever the governor is not yet seeded and has no samples -
  // even when performance256Ms <= 0 skips the seeding itself. They feed the
  // session cost ratio of step-up estimates and of the measured-cost overrun
  // step-down; reset() clears them, seedProbe() never sets them.
  void seedProbe(double medianWarmupMs);
  void seedMeasuredProbes(double full512Ms,
                          double balanced320Ms,
                          double performance256Ms);
  bool seeded() const { return seeded_; }

  // Which fused tiers have a prebuilt MODNet session (default prebuild is
  // 512+256, so Balanced320 usually does NOT exist). Ladder moves, estimates
  // and seeding skip unavailable fused tiers instead of requesting a phantom
  // size that ModnetKeyer::apply() would silently substitute — the substitute
  // ran at a different size than the governor's cost model assumed, so
  // step-up estimates and the reported tier were both wrong. Lite256/Off are
  // always reachable. Defaults keep every tier available (historical
  // behavior and the BROADIFY_MEETING_KEYER_PREBUILD_TIERS=all path).
  void setFusedTierAvailability(bool full512, bool balanced320,
                                bool performance256);

  // Estimate-based step-up, one tier per step. Fused tiers and Lite256 climb
  // only when (a) at least minSamples were observed at the current tier,
  // (b) at least the step-up holdoff elapsed since the last tier change and
  // (c) the next tier's estimated cost fits stepUpFactor * budget
  // (Lite256 -> Performance256 uses the async-measured EMA directly: same
  // input size). Off -> Lite256 stays time-based (async cannot stall the
  // program loop, and Off produces no samples to estimate from) but never
  // fires faster than the doubling, never-session-reset re-entry backoff.
  // Program-frame guard (measuredCostPolicy, fused -> fused climbs only,
  // incl. skips over unavailable tiers): with a known program state, a climb
  // whose estimate passed (c) is still NOT taken when the program frame fits
  // the budget now but would not after the climb:
  //   extra = max(0, estimate - EMA)
  //         + max(0, tensorMs) * (areaScale(target) / areaScale(tier) - 1)
  //   blocked when programFrameEma <= budget && programFrameEma + extra > budget
  // (the measured overrun step-down would undo it). A blocked climb changes
  // no state. Over budget already, or unknown program state -> climb as
  // before. Lite256 -> Performance256 and Off -> Lite256 are not guarded.
  // Call once per frame before consulting tier().
  void maybeStepUp(TimePoint now);

  // Latest program-frame state for the step-up guard: the BudgetOverrunReporter
  // EMA of the program frame, its budget and the latest fused tensor build
  // time. Values <= 0 mean unknown. Call every frame before maybeStepUp().
  void setProgramFrameState(double programFrameEmaMs, double budgetMs,
                            double tensorMs);

  // Feeds one measured inference cost. Fused tiers: only real fused inference
  // runs (not cadence-reused frames). Lite256: the async worker's measured
  // inference cost (basis of the Lite -> Performance256 estimate and of the
  // Lite -> Off guard).
  void addSample(double inferenceMs, TimePoint now);
  void setFrameOverheadMs(double overheadMs);

  // Sustained program-loop budget overrun (from the BudgetOverrunReporter):
  // step ONE fused tier down even though the inference EMA still fits the
  // budget. This is the CPU-overload path the GPU-only addSample() cannot see
  // (tensor build, postprocess and readbacks live in the program loop, not in
  // sessionRunMs). Only steps within the fused tiers (Full512/Balanced320 ->
  // the next available lower fused tier); leaving fused for Lite/Off stays
  // sample-driven (liteGate policy). No-op before seeding or at/below
  // Performance256. Does NOT feed addSample(), so the GPU-cost invariant holds.
  // This overload steps down UNCONDITIONALLY (the "always" mode,
  // BROADIFY_MEETING_OVERRUN_STEPDOWN=always).
  void noteProgramBudgetOverrun(TimePoint now);
  // Measured-cost variant (default mode): steps down only when the lower
  // tier can bring the program frame into budget. Projection:
  //   savings = sessionRunMs * (1 - sessionCostRatio(tier, target))
  //           + max(0, tensorMs) * (1 - areaScale(target) / areaScale(tier))
  //   projected = programFrameEmaMs - savings
  // projected <= budgetMs -> SteppedDown; otherwise NotTierBound and NO state
  // change (EMA, samples, clocks and watches stay as they are). Same
  // Ignored cases as the unconditional overload, plus a stale sample
  // (sample.tierAtEvent != tier()): Ignored with NO state change. Falls back to the
  // unconditional step-down (SteppedDown, savings/projected -1) when the
  // target is not a fused tier or the sample is invalid
  // (programFrameEmaMs/budgetMs/sessionRunMs <= 0). Wrong-estimate net
  // (measuredCostPolicy): any SteppedDown within overrunWrongEstimateWindow
  // of the last fused -> fused step-up doubles the step-up holdoff (capped at
  // reprobeMaxInterval, never reset within the session) unless stepDown()'s
  // own 30-sample watch already doubled for this step-down.
  OverrunOutcome noteProgramBudgetOverrun(TimePoint now,
                                          const ProgramOverrunSample &sample);

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
  double budgetThresholdMs() const { return stepDownThresholdMs(); }
  // Estimated cost of the next available tier above the current one (< 0
  // when no EMA exists or nothing is available to climb to).
  double stepUpEstimateMs() const { return estimatedStepUpMs(); }
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
  // Estimated cost of the next AVAILABLE tier above the current one, scaled
  // from the current-tier EMA by sessionCostRatio() (< 0 when no EMA exists
  // or nothing is available to climb to).
  double estimatedStepUpMs() const;
  // Relative MODNet session cost of `to` vs `from` (both fused tiers,
  // measuredCostPolicy on), in this order of preference:
  //   1. live/live: cost(from) = the current EMA when `from` is the current
  //      tier with >= minSamples samples, else the stored live cost of
  //      `from`; cost(to) = the stored live cost of `to`; both > 0;
  //   2. probe(to) / probe(from), both stored probes > 0;
  // clamped to [area, 1] for a step down and [1, area] for a step up (area =
  // areaScale(to) / areaScale(from)). Otherwise the area ratio itself (the
  // historical assumption, so behavior without live costs/probes or with
  // the policy off is unchanged).
  double sessionCostRatio(GovernorTier from, GovernorTier to) const;
  // Stored live session cost of a fused tier (<= 0 = never measured;
  // Lite256/Off have none).
  double storedLiveCostMs(GovernorTier tier) const;
  // Called right before every tier change (step-downs, step-ups incl.
  // commitLiteStepUp; NOT seeding): when leaving a fused tier with
  // >= minSamples samples, store its EMA as that tier's live cost; with fewer
  // samples the previously stored value is kept. measuredCostPolicy only.
  // Staleness: a stored value is only refreshed when the governor visits
  // that tier again.
  void rememberLiveCostOfCurrentTier();
  // Program-frame step-up guard (see maybeStepUp): true when the climb from
  // the current tier to `target` with the given estimate must not happen.
  bool stepUpBlockedByProgramFrame(GovernorTier target,
                                   double estimatedMs) const;
  // Stored build-time probe of a fused tier (<= 0 = unknown; Lite256/Off
  // have no probe).
  double storedProbeMs(GovernorTier tier) const;
  void stepDown(GovernorTier target, TimePoint now);
  bool tierAvailable(GovernorTier tier) const;
  // Ladder neighbors constrained to available tiers. Below: skips towards
  // Lite256/Off (always available). Above: skips towards Full512 and returns
  // the input tier unchanged when no available fused tier exists above it.
  GovernorTier availableTierBelow(GovernorTier tier) const;
  GovernorTier availableTierAbove(GovernorTier tier) const;

  KeyerGovernorConfig config_{};
  GovernorTier tier_ = GovernorTier::Full512;
  bool full512Available_ = true;
  bool balanced320Available_ = true;
  bool performance256Available_ = true;
  bool seeded_ = false;
  bool liteStepUpPending_ = false;
  double emaMs_ = -1.0;
  // Build-time probes from seedMeasuredProbes() (<= 0 = unknown).
  double probe512Ms_ = -1.0;
  double probe320Ms_ = -1.0;
  double probe256Ms_ = -1.0;
  // Program-frame state from setProgramFrameState() (<= 0 = unknown).
  double programFrameEmaMs_ = -1.0;
  double programBudgetMs_ = -1.0;
  double programTensorMs_ = -1.0;
  // Live session-cost EMA per fused tier, stored when leaving the tier
  // (<= 0 = never measured).
  double liveCost512Ms_ = -1.0;
  double liveCost320Ms_ = -1.0;
  double liveCost256Ms_ = -1.0;
  // Time of the last fused -> fused step-up (overrun wrong-estimate net);
  // only meaningful while fusedStepUpAtValid_ is true.
  bool fusedStepUpAtValid_ = false;
  TimePoint lastFusedStepUpAt_{};
  double frameOverheadMs_ = 0.0;
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
