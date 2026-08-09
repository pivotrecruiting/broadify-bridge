#pragma once

#include <chrono>
#include <cstdint>

namespace broadify::meeting {

struct TierHandoverConfig {
  // Upper bound for the fused->async step-down overlap: if the async worker
  // never publishes a pair, the cutover happens anyway after this budget,
  // preserving the pre-handover behavior (bounded double-inference cost).
  std::chrono::milliseconds maxStepDownOverlap{std::chrono::milliseconds(5000)};
};

// Make-before-break coordinator for governor tier transitions between the
// fused synchronous keyer and the async worker (Windows fused path).
//
// Motivation (field bug "keyer off for seconds after ~5 min"): the DirectML
// session build for a new input shape costs 0.25 s on an idle dGPU and up to
// ~12 s on an iGPU under load. The old transitions cut over IMMEDIATELY:
// - async_lite -> fused: the blocking session build ran INSIDE the first
//   fused apply(), so the program showed un-keyed output for its duration.
// - fused -> async_lite: the worker's chain builds its session on the first
//   submitted frame, so the program was un-keyed until the first pair.
//
// Pure logic, stdlib only, injected time; the caller (program loop) owns
// threading — warmup results produced on a worker thread must be observed by
// the caller (e.g. via an atomic) and fed in on the program thread.
class TierHandover {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  enum class Phase {
    Idle,
    // Step-up warmup in flight: the fused session for the target mode is
    // being built in the background while the async worker stays on air.
    Warming,
    // Step-down overlap: the fused keyer stays on air while the async worker
    // warms up (receives frames, builds its session, publishes a pair).
    Overlap,
  };

  TierHandover() = default;
  explicit TierHandover(const TierHandoverConfig &config) : config_(config) {}

  Phase phase() const { return phase_; }

  // --- Step-up (async_lite -> fused) -------------------------------------
  // Arms the warmup phase. Returns false unless Idle (single warmup in
  // flight; the caller additionally guards its worker thread with an atomic).
  bool beginWarmup(TimePoint now);
  // Feeds the warmup outcome observed from the worker thread. Ignored unless
  // Warming; transitions back to Idle and latches a one-shot outcome flag.
  void completeWarmup(bool success);
  // One-shot outcome consumption on the program thread: after completeWarmup
  // exactly one of these returns true exactly once (success -> commit the
  // governor's deferred step-up; failure -> wrong-estimate treatment).
  bool consumeWarmupSuccess();
  bool consumeWarmupFailure();

  // --- Step-down (fused -> async_lite) -----------------------------------
  // Arms the overlap phase; records the transition-start stamps. Returns
  // false unless Idle.
  bool beginOverlap(uint64_t nowNs, TimePoint now);
  // True once the async worker published a pair AFTER the overlap began
  // (publishedAtNs >= overlap start), or once the bounded overlap budget
  // expired (worker never published -> cut over anyway).
  bool cutoverDue(uint64_t latestPairPublishedAtNs, TimePoint now) const;
  // Distinguishes the clean cutover (fresh pair arrived; the worker's state
  // must SURVIVE the path-transition reset) from the timeout cutover.
  bool pairArrivedSinceOverlapStart(uint64_t latestPairPublishedAtNs) const;
  // Ends the overlap (after the caller performed the cutover) -> Idle.
  void finishOverlap();

  // Aborts any phase (keyer disabled / tier left the transition). Latched
  // warmup outcomes are dropped. A still-running warmup worker thread is the
  // caller's concern (its single-flight atomic keeps guarding reuse).
  void reset();

  // Introspection for tests/telemetry.
  uint64_t overlapStartNs() const { return overlapStartNs_; }

 private:
  TierHandoverConfig config_{};
  Phase phase_ = Phase::Idle;
  bool warmupSucceededPending_ = false;
  bool warmupFailedPending_ = false;
  uint64_t overlapStartNs_ = 0u;
  TimePoint overlapStartedAt_{};
};

}  // namespace broadify::meeting
