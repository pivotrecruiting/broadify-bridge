#include "pipeline/tier_handover.h"

#include <chrono>
#include <cstdint>
#include <iostream>

using broadify::meeting::TierHandover;
using broadify::meeting::TierHandoverConfig;

namespace {

using TimePoint = TierHandover::TimePoint;
using Phase = TierHandover::Phase;

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "tier_handover_test failed: " << what << std::endl;
  }
  return condition;
}

constexpr uint64_t kMsToNs = 1000000ull;

TimePoint at(int ms) { return TimePoint{} + std::chrono::milliseconds(ms); }

}  // namespace

int main() {
  bool ok = true;

  {
    // Step-down make-before-break vs the old immediate cutover: while the
    // async worker has not published a pair since the transition start, the
    // cutover must NOT be due (the old behavior cut over immediately and
    // showed un-keyed output until the worker's first pair).
    TierHandover handover;
    ok &= expect(handover.phase() == Phase::Idle, "starts Idle");
    ok &= expect(handover.beginOverlap(1000ull * kMsToNs, at(0)),
                 "overlap begins from Idle");
    ok &= expect(handover.phase() == Phase::Overlap, "phase is Overlap");
    ok &= expect(!handover.beginOverlap(2000ull * kMsToNs, at(1)),
                 "no second overlap while one is active");
    ok &= expect(!handover.cutoverDue(0u, at(100)),
                 "no pair yet: cutover NOT due (make-before-break)");
    // A pair published BEFORE the overlap began is the previous epoch's
    // stale output and must not trigger the cutover.
    ok &= expect(!handover.cutoverDue(999ull * kMsToNs, at(100)),
                 "stale pre-overlap pair does not cut over");
    ok &= expect(!handover.pairArrivedSinceOverlapStart(999ull * kMsToNs),
                 "stale pair is not a fresh arrival");
    // The worker's first pair after the transition start cuts over.
    ok &= expect(handover.cutoverDue(1500ull * kMsToNs, at(200)),
                 "fresh pair after overlap start: cutover due");
    ok &= expect(handover.pairArrivedSinceOverlapStart(1500ull * kMsToNs),
                 "fresh pair is a fresh arrival");
    handover.finishOverlap();
    ok &= expect(handover.phase() == Phase::Idle, "finishOverlap returns Idle");
  }

  {
    // Bounded overlap: if the worker never publishes, the cutover happens
    // anyway after maxStepDownOverlap (preserves today's behavior instead of
    // paying double inference forever).
    TierHandoverConfig config;
    config.maxStepDownOverlap = std::chrono::milliseconds(5000);
    TierHandover handover(config);
    handover.beginOverlap(1000ull * kMsToNs, at(0));
    ok &= expect(!handover.cutoverDue(0u, at(4999)),
                 "inside the overlap budget: not due without a pair");
    ok &= expect(handover.cutoverDue(0u, at(5000)),
                 "overlap budget exhausted: cutover due without a pair");
    ok &= expect(!handover.pairArrivedSinceOverlapStart(0u),
                 "timeout cutover reports no fresh pair (full reset path)");
    handover.finishOverlap();
    ok &= expect(handover.phase() == Phase::Idle, "timeout cutover ends Idle");
  }

  {
    // Step-up warmup: single-flight, one-shot success consumption. The old
    // behavior had no warmup phase at all — the transition (and the blocking
    // session build) happened immediately.
    TierHandover handover;
    ok &= expect(handover.beginWarmup(at(0)), "warmup begins from Idle");
    ok &= expect(handover.phase() == Phase::Warming, "phase is Warming");
    ok &= expect(!handover.beginWarmup(at(1)), "only one warmup in flight");
    ok &= expect(!handover.beginOverlap(1u, at(1)),
                 "no overlap while warming");
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "no success before completion");
    handover.completeWarmup(true);
    ok &= expect(handover.phase() == Phase::Idle, "completion returns Idle");
    ok &= expect(!handover.consumeWarmupFailure(),
                 "success does not read as failure");
    ok &= expect(handover.consumeWarmupSuccess(), "success consumed once");
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "success is one-shot");
  }

  {
    // Step-up warmup failure path (wrong-estimate treatment downstream).
    TierHandover handover;
    handover.beginWarmup(at(0));
    handover.completeWarmup(false);
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "failure does not read as success");
    ok &= expect(handover.consumeWarmupFailure(), "failure consumed once");
    ok &= expect(!handover.consumeWarmupFailure(), "failure is one-shot");
  }

  {
    // completeWarmup outside Warming is ignored (a late worker-thread result
    // after a reset must not resurrect a consumed transition).
    TierHandover handover;
    handover.completeWarmup(true);
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "completion outside Warming is ignored");
  }

  {
    // reset() aborts any phase and drops latched outcomes (keyer disable).
    TierHandover handover;
    handover.beginWarmup(at(0));
    handover.completeWarmup(true);
    handover.reset();
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "reset drops the latched warmup success");
    handover.beginOverlap(1000ull * kMsToNs, at(0));
    handover.reset();
    ok &= expect(handover.phase() == Phase::Idle, "reset aborts the overlap");
    ok &= expect(handover.beginWarmup(at(1)),
                 "reset re-enables a fresh transition");
  }

  {
    // Keyer disabled DURING an in-flight warmup (the frame_pipeline busy-gate
    // scenario): reset() returns the phase to Idle while the warmup thread
    // keeps running; its LATE completion must be ignored — the caller's
    // fusedWarmupBusy flag, not the phase, is what keeps guarding the keyer
    // mutex until that thread's body actually finishes.
    TierHandover handover;
    handover.beginWarmup(at(0));
    handover.reset();
    ok &= expect(handover.phase() == Phase::Idle,
                 "reset during Warming returns Idle");
    handover.completeWarmup(true);
    ok &= expect(handover.phase() == Phase::Idle,
                 "late completion after reset does not resurrect a phase");
    ok &= expect(!handover.consumeWarmupSuccess(),
                 "late completion after reset does not latch an outcome");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "tier_handover_test passed" << std::endl;
  return 0;
}
