#include "keyer/keyer_governor.h"

#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

using broadify::meeting::GovernorTier;
using broadify::meeting::KeyerAutoGovernor;
using broadify::meeting::KeyerGovernorConfig;
using broadify::meeting::OverrunDecision;
using broadify::meeting::OverrunOutcome;
using broadify::meeting::ProgramOverrunSample;

namespace {

using TimePoint = KeyerAutoGovernor::TimePoint;

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "keyer_governor_test failed: " << what << std::endl;
  }
  return condition;
}

KeyerGovernorConfig testConfig() {
  KeyerGovernorConfig config;
  config.frameBudgetMs = 1000.0 / 30.0;  // 33.33ms
  return config;
}

TimePoint at(int seconds) {
  return TimePoint{} + std::chrono::seconds(seconds);
}

// Feeds `count` samples of `ms` at time `when`.
void feed(KeyerAutoGovernor &governor, double ms, int count, TimePoint when) {
  for (int i = 0; i < count; ++i) {
    governor.addSample(ms, when);
  }
}

bool near(double actual, double expected) {
  return std::fabs(actual - expected) <= 1e-9;
}

// `tierAtEvent`: the governor tier the costs were measured at (must match the
// governor's current tier, otherwise the sample is stale and Ignored).
ProgramOverrunSample overrunSample(GovernorTier tierAtEvent,
                                   double programFrameEmaMs, double budgetMs,
                                   double sessionRunMs, double tensorMs) {
  ProgramOverrunSample sample;
  sample.programFrameEmaMs = programFrameEmaMs;
  sample.budgetMs = budgetMs;
  sample.sessionRunMs = sessionRunMs;
  sample.tensorMs = tensorMs;
  sample.tierAtEvent = tierAtEvent;
  return sample;
}

}  // namespace

int main() {
  bool ok = true;

  {
    // Ladder descent: a steady 40ms EMA (over budget, but not 2.5x) steps
    // down one tier per full 10-sample window, all the way to async lite.
    KeyerAutoGovernor governor(testConfig());
    ok &= expect(governor.tier() == GovernorTier::Full512, "starts at Full512");
    feed(governor, 40.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "descends to Balanced320 after minSamples over budget");
    feed(governor, 40.0, 9, at(2));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "no step before minSamples at the new tier");
    feed(governor, 40.0, 1, at(2));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "descends to Performance256");
    feed(governor, 40.0, 10, at(3));
    ok &= expect(governor.tier() == GovernorTier::Lite256, "descends to Lite256");
    ok &= expect(governor.wantsAsyncLite(), "Lite256 wants async lite");
    ok &= expect(!governor.wantsOff(), "Lite256 is not off");
    // 40ms at Lite256 is fine (< offInferenceMs): never leaves Lite via budget.
    feed(governor, 40.0, 20, at(4));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "over-budget-but-usable EMA stays at Lite256");
  }

  {
    // Fast start: a grossly over-budget EMA (200ms > 2.5 * 33.3ms) steps down
    // after only 3 samples per tier instead of waiting for 10.
    KeyerAutoGovernor governor(testConfig());
    feed(governor, 200.0, 3, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "fast start steps down after 3 samples");
    feed(governor, 200.0, 3, at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "fast start cascades to Performance256");
    feed(governor, 200.0, 3, at(1));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "fast start cascades to Lite256");
  }

  {
    // seedProbe heuristic (area scaling from the 512 probe: x0.39 for 320,
    // x0.25 for 256).
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(26.0);
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "seed 26ms -> Full512");
    governor.reset();
    governor.seedProbe(60.0);  // 60*0.39=23.4 <= 33.3
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "seed 60ms -> Balanced320");
    governor.reset();
    governor.seedProbe(120.0);  // 120*0.25=30 <= 33.3
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "seed 120ms -> Performance256");
    governor.reset();
    // The spec case: 194ms at 512 with a 33.3ms budget. 194*0.25=48.5 does
    // not fit the fused budget but is well under offInferenceMs (120), so
    // async lite (not the fused Performance256 tier) is the right jump.
    governor.seedProbe(194.0);
    ok &= expect(governor.tier() == GovernorTier::Lite256, "seed 194ms -> Lite256");
    governor.reset();
    governor.seedProbe(500.0);  // 500*0.25=125 > 120 -> even async is useless
    ok &= expect(governor.tier() == GovernorTier::Off, "seed 500ms -> Off");
    ok &= expect(governor.wantsOff(), "Off tier reports wantsOff");
    governor.reset();
    governor.seedProbe(60.0);
    governor.seedProbe(500.0);  // second seed must be ignored
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "seedProbe is one-shot");
  }

  {
    // Measured tier probes beat the old 512-area estimate, but startup must
    // never seed below Performance256 from build-time probes. Lite/Off require
    // live async samples, because first-load contention can inflate probes.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(/*full512Ms=*/60.0,
                                /*balanced320Ms=*/30.0,
                                /*performance256Ms=*/30.0);
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "measured probes clamp at Performance256");
    governor.reset();
    governor.seedMeasuredProbes(/*full512Ms=*/400.0,
                                /*balanced320Ms=*/180.0,
                                /*performance256Ms=*/130.0);
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "measured probes never seed Off");
    governor.reset();
    governor.seedMeasuredProbes(/*full512Ms=*/60.0,
                                /*balanced320Ms=*/24.0,
                                /*performance256Ms=*/30.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "measured probes choose the best sustainable tier");
    governor.seedMeasuredProbes(/*full512Ms=*/1.0,
                                /*balanced320Ms=*/1.0,
                                /*performance256Ms=*/1.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "measured probe seeding is one-shot");
  }
  {
    // The climb threshold is derived from the actual step-down threshold and
    // clamped to it, so the hysteresis band cannot invert even if a future
    // config accidentally sets stepUpFactor > 1. A 34ms async estimate would
    // immediately step down at Performance256 (threshold 33.3ms); it must not
    // be allowed to step up from Lite256.
    KeyerGovernorConfig config = testConfig();
    config.stepUpFactor = 1.4;
    KeyerAutoGovernor governor(config);
    governor.seedProbe(400.0);  // Lite256
    governor.maybeStepUp(at(1));
    feed(governor, 34.0, 10, at(1));
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "step-up band never inverts");
  }

  {
    // FIELD REGRESSION (RC live test 2026-08-09, hybrid GTX 1660 Ti + UHD
    // 630, DirectML under GPU contention): live async inference EMA 62ms at a
    // 33.3ms budget. The old live-probe step-up climbed every backoff
    // interval and fell straight back — user-visible mode flapping
    // (fused_cadence -> async_lite -> fused -> ...). The estimate policy must
    // pin the tier: 62ms estimate > 0.8 * 33.3ms = 26.7ms, and 62ms <
    // offInferenceMs, so async_lite FOREVER — zero transitions across 35
    // simulated minutes of samples and elapsed time.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(248.0);  // 248*0.25=62 -> seeds Lite256
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "field seed lands at Lite256");
    int transitions = 0;
    GovernorTier previous = governor.tier();
    for (int second = 1; second <= 2100; ++second) {  // 35 minutes
      governor.maybeStepUp(at(second));
      // ~15 async masks/s in the field; a few samples per second keep the
      // EMA saturated without slowing the test down.
      feed(governor, 62.0, 4, at(second));
      if (governor.tier() != previous) {
        ++transitions;
        previous = governor.tier();
      }
    }
    ok &= expect(transitions == 0, "field case: zero tier transitions");
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "field case stays async_lite forever");
    ok &= expect(std::string(governor.pipelineModeLabel(false)) == "async_lite",
                 "field case label stays async_lite");
  }

  {
    // Genuinely fast machine: async EMA 15ms at Lite256. The estimate (same
    // input size, 15ms <= 26.7ms) steps up after minSamples
    // AND the 10s dwell — then Performance256 and Balanced320 fit, while Full512 does not.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(400.0);  // 400*0.25=100 <= 120 -> Lite256
    ok &= expect(governor.tier() == GovernorTier::Lite256, "seeded at Lite256");
    governor.maybeStepUp(at(1));  // starts the dwell clock
    feed(governor, 15.0, 5, at(1));
    governor.maybeStepUp(at(5));  // 5 samples: blocked by minSamples
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "no step-up before minSamples");
    feed(governor, 15.0, 5, at(5));
    governor.maybeStepUp(at(6));  // 10 samples, but only 5s dwell: blocked
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "no step-up before the dwell time");
    int transitions = 0;
    GovernorTier previous = governor.tier();
    for (int second = 7; second <= 600; ++second) {
      governor.maybeStepUp(at(second));
      feed(governor, 15.0, 4, at(second));
      if (governor.tier() != previous) {
        ++transitions;
        previous = governor.tier();
      }
    }
    ok &= expect(transitions == 2, "fast machine steps up twice");
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "fast machine lands at Balanced320 and stays");
    ok &= expect(!governor.wantsAsyncLite(), "fused tier after step-up");
  }

  {
    // Wrong estimate: the async EMA promised a fit, but the real fused cost
    // is 60ms. One step-down (within stableSamples of the step-up) doubles
    // the step-up holdoff persistently; the next attempt must wait the
    // doubled interval.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(400.0);  // Lite256
    governor.maybeStepUp(at(1));  // starts the dwell clock
    feed(governor, 15.0, 10, at(1));
    governor.maybeStepUp(at(11));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "estimate-based step-up fires");
    feed(governor, 60.0, 10, at(12));  // reality: over budget -> step down
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "wrong estimate steps down once");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(20),
                 "wrong estimate doubles the step-up holdoff");
    feed(governor, 15.0, 19, at(13));
    governor.maybeStepUp(at(22));  // 10s since step-down: blocked (20s now)
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "doubled holdoff blocks the old 10s retry");
    governor.maybeStepUp(at(32));  // 20s since step-down: allowed
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "step-up retries after the doubled holdoff");
  }

  {
    // Off threshold and Off -> Lite256 re-entry: at Lite256 a smoothed cost
    // above offInferenceMs (120ms) turns the keyer off after a full sample
    // window; re-entry is time-based, and a relapse doubles the (never-reset)
    // re-entry backoff.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(194.0);
    ok &= expect(governor.tier() == GovernorTier::Lite256, "seeded at Lite256");
    feed(governor, 130.0, 9, at(1));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "no off before minSamples");
    feed(governor, 130.0, 1, at(1));
    ok &= expect(governor.tier() == GovernorTier::Off, "130ms EMA at Lite256 -> Off");
    // Off ignores further samples.
    feed(governor, 10.0, 30, at(2));
    ok &= expect(governor.tier() == GovernorTier::Off, "Off ignores samples");
    // Off re-enters Lite256 after the backoff, no probe needed.
    governor.maybeStepUp(at(100));  // backoff started at the off transition
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "Off climbs back to Lite256 after backoff");
    // The re-entry relapses within stableSamples -> the re-entry backoff
    // doubles and never resets for the session.
    feed(governor, 130.0, 10, at(105));
    ok &= expect(governor.tier() == GovernorTier::Off, "re-entry relapses to Off");
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(120),
                 "relapse doubles the re-entry backoff");
    governor.maybeStepUp(at(105 + 60));
    ok &= expect(governor.tier() == GovernorTier::Off,
                 "doubled backoff blocks the 60s re-entry");
    governor.maybeStepUp(at(105 + 120));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "re-entry fires after the doubled backoff");
  }

  {
    // The step-up holdoff is capped at reprobeMaxInterval.
    KeyerGovernorConfig config = testConfig();
    config.reprobeMaxInterval = std::chrono::seconds(30);
    KeyerAutoGovernor governor(config);
    governor.seedProbe(400.0);  // Lite256
    int now = 0;
    governor.maybeStepUp(at(now));  // starts the dwell clock
    for (int round = 0; round < 4; ++round) {
      feed(governor, 15.0, 10, at(now));  // async promises a fit
      now += 700;                         // beyond any holdoff
      governor.maybeStepUp(at(now));
      ok &= expect(governor.tier() == GovernorTier::Performance256,
                   "capped-holdoff round steps up");
      feed(governor, 60.0, 10, at(now));  // reality disagrees -> down
      ok &= expect(governor.tier() == GovernorTier::Lite256,
                   "capped-holdoff round steps down");
    }
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(30),
                 "step-up holdoff is capped at reprobeMaxInterval");
  }

  {
    // WP7 overhead budget shrink: tiering still samples only session cost, but
    // the step-down/step-up budget sees program-loop overhead.
    KeyerAutoGovernor governor(testConfig());
    governor.setFrameOverheadMs(15.0);
    feed(governor, 20.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "20ms session cost steps down when 15ms overhead shrinks budget");
    feed(governor, 8.0, 10, at(2));
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "8ms at Balanced320 does not step up under overhead budget");
  }

  {
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(/*full512Ms=*/80.0,
                                /*balanced320Ms=*/60.0,
                                /*performance256Ms=*/20.0);
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "overhead floor case starts at Performance256");
    governor.setFrameOverheadMs(30.0);
    feed(governor, 5.0, 30, at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "overhead floor never pushes Performance256 to Lite");
  }

  {
    KeyerGovernorConfig config = testConfig();
    config.stepDownOverrideMs = 25.0;
    KeyerAutoGovernor governor(config);
    governor.setFrameOverheadMs(30.0);
    feed(governor, 26.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "step-down override ignores overhead shrink");
  }

  {
    // Warm-handover deferral (before-red vs the immediate step-up): with
    // deferLiteStepUp the estimate-approved Lite256 -> Performance256 step-up
    // must NOT change the tier — it latches liteStepUpPending() until the
    // caller's background warmup commits it. Without the flag (the default
    // and the kill-switch path) the same inputs flip the tier immediately.
    KeyerGovernorConfig deferred = testConfig();
    deferred.deferLiteStepUp = true;
    KeyerAutoGovernor governor(deferred);
    governor.seedProbe(400.0);  // Lite256
    governor.maybeStepUp(at(1));  // starts the dwell clock
    feed(governor, 15.0, 10, at(1));
    governor.maybeStepUp(at(12));  // estimate fits, dwell elapsed
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "deferred step-up keeps the tier at Lite256");
    ok &= expect(governor.liteStepUpPending(), "deferred step-up is pending");
    ok &= expect(governor.wantsAsyncLite(),
                 "async stays the active path while warming");
    governor.maybeStepUp(at(13));  // pending latches; no re-evaluation churn
    ok &= expect(governor.liteStepUpPending() &&
                     governor.tier() == GovernorTier::Lite256,
                 "pending stays latched across frames");
    // Warmup succeeded -> commit performs the exact immediate-step-up
    // semantics (tier, sample reset, wrong-estimate watch).
    governor.commitLiteStepUp(at(14));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "commit moves to Performance256");
    ok &= expect(!governor.liteStepUpPending(), "commit clears pending");
    feed(governor, 60.0, 10, at(15));  // reality: over budget -> relapse
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "post-commit relapse steps down");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(20),
                 "post-commit relapse doubles the holdoff (watch armed)");

    // Same inputs WITHOUT deferral: the tier flips immediately (documents
    // the old behavior the kill-switch restores).
    KeyerAutoGovernor immediate(testConfig());
    immediate.seedProbe(400.0);
    immediate.maybeStepUp(at(1));
    feed(immediate, 15.0, 10, at(1));
    immediate.maybeStepUp(at(12));
    ok &= expect(immediate.tier() == GovernorTier::Performance256,
                 "without deferral the step-up is immediate");
    ok &= expect(!immediate.liteStepUpPending(),
                 "immediate step-up never reports pending");
  }

  {
    // Warmup failure -> cancelLiteStepUp is the wrong-estimate treatment:
    // stays at Lite256, doubles the step-up holdoff persistently, restarts
    // the dwell clock so the next attempt waits the doubled interval.
    KeyerGovernorConfig deferred = testConfig();
    deferred.deferLiteStepUp = true;
    KeyerAutoGovernor governor(deferred);
    governor.seedProbe(400.0);  // Lite256
    governor.maybeStepUp(at(1));
    feed(governor, 15.0, 10, at(1));
    governor.maybeStepUp(at(12));
    ok &= expect(governor.liteStepUpPending(), "pending before the failure");
    governor.cancelLiteStepUp(at(13));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "cancel stays at Lite256");
    ok &= expect(!governor.liteStepUpPending(), "cancel clears pending");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(20),
                 "cancel doubles the step-up holdoff");
    feed(governor, 15.0, 10, at(14));
    governor.maybeStepUp(at(13 + 10));  // old 10s holdoff: blocked now
    ok &= expect(!governor.liteStepUpPending() &&
                     governor.tier() == GovernorTier::Lite256,
                 "doubled holdoff blocks the old retry interval");
    governor.maybeStepUp(at(13 + 21));  // doubled holdoff elapsed
    ok &= expect(governor.liteStepUpPending(),
                 "retry re-pends after the doubled holdoff");

    // A step-down while pending (async EMA blew past the off guard during
    // the warmup) invalidates the pending step-up.
    KeyerAutoGovernor blown(deferred);
    blown.seedProbe(400.0);
    blown.maybeStepUp(at(1));
    feed(blown, 15.0, 10, at(1));
    blown.maybeStepUp(at(12));
    ok &= expect(blown.liteStepUpPending(), "pending before the off guard");
    feed(blown, 200.0, 10, at(13));  // EMA > offInferenceMs -> Off
    ok &= expect(blown.tier() == GovernorTier::Off, "off guard fires");
    ok &= expect(!blown.liteStepUpPending(), "step-down clears pending");
    blown.commitLiteStepUp(at(14));  // late warmup success must be a no-op
    ok &= expect(blown.tier() == GovernorTier::Off,
                 "late commit after step-down is a no-op");
  }

  {
    // Testing override replaces the step-down threshold (and scales the
    // step-up threshold base with it).
    KeyerGovernorConfig config = testConfig();
    config.stepDownOverrideMs = 50.0;
    KeyerAutoGovernor governor(config);
    feed(governor, 40.0, 10, at(1));  // over budget but under the override
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "override raises the threshold");
    feed(governor, 60.0, 10, at(2));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "override threshold still degrades");
  }

  {
    // VCam-aware policy: degrade by fused tier first; async Lite requires a
    // sustained 30-sample over-budget run at fused 256.
    KeyerGovernorConfig config = testConfig();
    config.tierFirstPolicy = true;
    config.liteGateSamples = 30u;
    KeyerAutoGovernor governor(config);
    feed(governor, 40.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "VCam policy still drops 512 -> 320");
    feed(governor, 40.0, 10, at(2));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "VCam policy still drops 320 -> 256");
    feed(governor, 40.0, 29, at(3));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "29 over-budget 256 samples stay fused");
    feed(governor, 40.0, 1, at(4));
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "30 over-budget 256 samples enter Lite256");
  }

  {
    // reset() returns to a clean, unseeded Full512 with base backoffs.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(500.0);
    ok &= expect(governor.seeded(), "seeded before reset");
    governor.reset();
    ok &= expect(governor.tier() == GovernorTier::Full512, "reset -> Full512");
    ok &= expect(!governor.seeded(), "reset clears seeded");
    ok &= expect(!governor.wantsOff() && !governor.wantsAsyncLite(),
                 "reset clears degradation");
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(60),
                 "reset restores the base re-entry backoff");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(10),
                 "reset restores the base step-up holdoff");
  }

  {
    // Labels for the bridge status field.
    KeyerAutoGovernor governor(testConfig());
    ok &= expect(std::string(governor.pipelineModeLabel(false)) == "fused",
                 "Full512 label fused");
    ok &= expect(std::string(governor.pipelineModeLabel(true)) == "fused_cadence",
                 "Full512 + cadence label fused_cadence");
    governor.seedProbe(194.0);
    ok &= expect(std::string(governor.pipelineModeLabel(false)) == "async_lite",
                 "Lite256 label async_lite");
    governor.reset();
    governor.seedProbe(500.0);
    ok &= expect(std::string(governor.pipelineModeLabel(false)) == "off_reduced",
                 "Off label off_reduced");
    // Performance-mode mapping.
    governor.reset();
    ok &= expect(std::string(governor.performanceModeForTier()) == "high_quality",
                 "Full512 -> high_quality");
    governor.seedProbe(60.0);
    ok &= expect(std::string(governor.performanceModeForTier()) == "balanced",
                 "Balanced320 -> balanced");
    governor.reset();
    governor.seedProbe(120.0);
    ok &= expect(std::string(governor.performanceModeForTier()) == "performance",
                 "Performance256 -> performance");
    governor.reset();
    governor.seedProbe(194.0);
    ok &= expect(std::string(governor.performanceModeForTier()) == "performance",
                 "Lite256 -> performance");
  }


  {
    // Tier availability (default prebuild = 512+256): the ladder skips the
    // phantom Balanced320 tier in both directions.
    KeyerAutoGovernor governor(testConfig());
    governor.setFusedTierAvailability(true, false, true);
    feed(governor, 40.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "descent skips unavailable Balanced320");
    // Step-up estimate must use the real 256 -> 512 area ratio (x4), not the
    // 256 -> 320 ratio of the skipped tier: ema 8ms -> est 32ms > 26.7ms
    // threshold -> must NOT climb (the old x1.5625 ratio would have climbed).
    feed(governor, 8.0, 10, at(2));
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "skip step-up estimate uses x4 area ratio");
    // ema 5ms -> est 20ms fits with margin -> climbs directly to Full512.
    KeyerAutoGovernor climber(testConfig());
    climber.setFusedTierAvailability(true, false, true);
    feed(climber, 40.0, 10, at(1));
    feed(climber, 5.0, 10, at(2));
    climber.maybeStepUp(at(12));
    ok &= expect(climber.tier() == GovernorTier::Full512,
                 "step-up skips unavailable Balanced320 to Full512");
  }

  {
    // Seeding skips unavailable tiers instead of seeding a phantom.
    KeyerAutoGovernor governor(testConfig());
    governor.setFusedTierAvailability(true, false, true);
    // probe 60ms: est512=60 too big, est320=23.4 would fit but is
    // unavailable, est256=15 fits -> Performance256.
    governor.seedProbe(60.0);
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "seedProbe skips unavailable Balanced320");

    KeyerAutoGovernor measured(testConfig());
    measured.setFusedTierAvailability(true, false, true);
    // 320 probe would fit the step-up threshold but the session is missing.
    measured.seedMeasuredProbes(40.0, 20.0, 18.0);
    ok &= expect(measured.tier() == GovernorTier::Performance256,
                 "seedMeasuredProbes skips unavailable Balanced320");
  }

  {
    // Default availability keeps the historical full ladder (also the
    // BROADIFY_MEETING_KEYER_PREBUILD_TIERS=all path).
    KeyerAutoGovernor governor(testConfig());
    governor.setFusedTierAvailability(true, true, true);
    feed(governor, 40.0, 10, at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "full availability keeps Balanced320 in the ladder");
  }


  {
    // Program-loop budget overrun sheds one fused tier even though the
    // inference EMA still fits: default prebuild (512+256), so Full512 skips
    // the phantom Balanced320 straight to Performance256.
    KeyerAutoGovernor governor(testConfig());
    governor.setFusedTierAvailability(true, false, true);
    governor.seedProbe(10.0);  // seeds Full512 (10ms fits the budget)
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "overrun test seeds Full512");
    governor.noteProgramBudgetOverrun(at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "overrun steps Full512 down to Performance256 (skips 320)");
  }

  {
    // With all tiers available the overrun steps one tier at a time.
    KeyerAutoGovernor governor(testConfig());
    governor.setFusedTierAvailability(true, true, true);
    governor.seedProbe(10.0);
    governor.noteProgramBudgetOverrun(at(1));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "overrun steps Full512 -> Balanced320 when available");
  }

  {
    // No-op at/below Performance256 (leaving fused is the liteGate's job) and
    // before seeding.
    KeyerAutoGovernor unseeded(testConfig());
    unseeded.noteProgramBudgetOverrun(at(1));
    ok &= expect(unseeded.tier() == GovernorTier::Full512,
                 "overrun before seeding is a no-op");

    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(120.0);  // seeds Performance256
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "overrun test seeds Performance256");
    governor.noteProgramBudgetOverrun(at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "overrun at Performance256 is a no-op");
  }

  // ---- Measured-cost program-overrun step-down (2026-10-17 field fix) ----
  // Default config, no frame overhead: the measured-probe seed threshold is
  // 0.8 * 33.33 = 26.67ms. Step-down area ratio 256/320 = 0.25/0.390625 =
  // 0.64, so the tensor term always saves tensorMs * 0.36 on 320 -> 256.

  {
    // F1: probes 512=30 (> 26.67), 320=11 (fits) -> seed Balanced320. The
    // measured session ratio 9/11 lies inside the step-down clamp [0.64, 1]:
    // savings = 11 * (1 - 9/11) + 3 * (1 - 0.64) = 2.0 + 1.08 = 3.08.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(/*full512Ms=*/30.0, /*balanced320Ms=*/11.0,
                                /*performance256Ms=*/9.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F1 probes 30/11/9 seed Balanced320");
    // ema 40 -> projected 40 - 3.08 = 36.92 > 33.3: not tier-bound.
    const OverrunOutcome skipped = governor.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(skipped.decision == OverrunDecision::NotTierBound,
                 "F1 ema 40 is not tier-bound");
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F1 not-tier-bound keeps Balanced320");
    ok &= expect(near(skipped.estimatedSavingsMs, 3.08),
                 "F1 savings 3.08 (ratio 9/11)");
    ok &= expect(near(skipped.projectedMs, 36.92), "F1 projected 36.92");
    // ema 36 -> projected 36 - 3.08 = 32.92 <= 33.3: the lower tier fits.
    const OverrunOutcome stepped = governor.noteProgramBudgetOverrun(
        at(2), overrunSample(GovernorTier::Balanced320, 36.0, 33.3, 11.0, 3.0));
    ok &= expect(stepped.decision == OverrunDecision::SteppedDown,
                 "F1 ema 36 steps down");
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "F1 steps Balanced320 -> Performance256");
    ok &= expect(near(stepped.estimatedSavingsMs, 3.08),
                 "F1 step-down savings 3.08");
    ok &= expect(near(stepped.projectedMs, 32.92), "F1 projected 32.92");
  }

  {
    // F1 clamp: probes 320=11, 256=6 -> ratio 6/11 = 0.545 is clamped UP to
    // the area ratio 0.64: savings = 11 * 0.36 + 3 * 0.36 = 3.96 + 1.08 =
    // 5.04.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 6.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F1 clamp probes 30/11/6 seed Balanced320");
    // ema 40 -> projected 34.96 > 33.3.
    const OverrunOutcome skipped = governor.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(skipped.decision == OverrunDecision::NotTierBound,
                 "F1 clamp ema 40 is not tier-bound");
    ok &= expect(near(skipped.estimatedSavingsMs, 5.04),
                 "F1 clamp savings 5.04 (ratio clamped to 0.64)");
    ok &= expect(near(skipped.projectedMs, 34.96), "F1 clamp projected 34.96");
    // ema 38 -> projected 32.96 <= 33.3.
    const OverrunOutcome stepped = governor.noteProgramBudgetOverrun(
        at(2), overrunSample(GovernorTier::Balanced320, 38.0, 33.3, 11.0, 3.0));
    ok &= expect(stepped.decision == OverrunDecision::SteppedDown &&
                     governor.tier() == GovernorTier::Performance256,
                 "F1 clamp ema 38 steps down to Performance256");
    ok &= expect(near(stepped.projectedMs, 32.96), "F1 clamp projected 32.96");
  }

  {
    // F2: equal probes (320=11, 256=11) -> ratio 1.0, the session saves
    // nothing; only the tensor term saves 3 * 0.36 = 1.08. Even at ema 35
    // (projected 33.92 > 33.3) the overrun is not tier-bound, and NO governor
    // state changes: tier, EMA, sample count and dwell clock all survive.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 11.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F2 probes 30/11/11 seed Balanced320");
    governor.maybeStepUp(at(0));  // starts the dwell clock
    feed(governor, 5.0, 10, at(1));
    const double emaBefore = governor.inferenceEmaMs();
    const OverrunOutcome skipped = governor.noteProgramBudgetOverrun(
        at(5), overrunSample(GovernorTier::Balanced320, 35.0, 33.3, 11.0, 3.0));
    ok &= expect(skipped.decision == OverrunDecision::NotTierBound,
                 "F2 equal probes: not tier-bound at ema 35");
    ok &= expect(near(skipped.estimatedSavingsMs, 1.08),
                 "F2 savings come from the tensor only (1.08)");
    ok &= expect(near(skipped.projectedMs, 33.92), "F2 projected 33.92");
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F2 tier unchanged");
    ok &= expect(governor.inferenceEmaMs() == emaBefore, "F2 EMA unchanged");
    // Sample count and dwell clock unchanged: 10 samples since the seed and
    // 10s since the clock start (at 0) still allow the estimate-based climb
    // (EMA 5 * clamped probe ratio 30/11 -> 2.56 = 12.8 <= 26.67). A reset
    // (samples 0, clock restarted at 5s) would block it.
    governor.maybeStepUp(at(10));
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "F2 samples and dwell clock survive a not-tier-bound overrun");
  }

  {
    // F3: probes unknown (seedProbe path) -> the session ratio falls back to
    // the area ratio 0.64: savings = 11 * 0.36 + 3 * 0.36 = 5.04.
    const double areaSavings = 11.0 * (1.0 - 0.64) + 3.0 * (1.0 - 0.64);
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(60.0);  // 60*0.39 = 23.4 <= 33.3 -> Balanced320
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F3 seedProbe 60 -> Balanced320");
    const OverrunOutcome skipped = governor.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(skipped.decision == OverrunDecision::NotTierBound,
                 "F3 unknown probes: ema 40 not tier-bound (34.96 > 33.3)");
    ok &= expect(near(skipped.estimatedSavingsMs, areaSavings) &&
                     near(skipped.estimatedSavingsMs, 5.04),
                 "F3 unknown probes use the area ratio (5.04)");
    const OverrunOutcome stepped = governor.noteProgramBudgetOverrun(
        at(2), overrunSample(GovernorTier::Balanced320, 38.0, 33.3, 11.0, 3.0));
    ok &= expect(stepped.decision == OverrunDecision::SteppedDown &&
                     governor.tier() == GovernorTier::Performance256,
                 "F3 unknown probes: ema 38 steps down (32.96 <= 33.3)");

    // Zero probe = unknown: a 256 probe of 0 stores the probes but does not
    // seed; the later seedProbe() seeds, and 320 -> 256 falls back to area.
    KeyerAutoGovernor zeros(testConfig());
    zeros.seedMeasuredProbes(30.0, 11.0, 0.0);
    ok &= expect(!zeros.seeded(), "F3 zero 256 probe does not seed");
    zeros.seedProbe(60.0);
    ok &= expect(zeros.tier() == GovernorTier::Balanced320,
                 "F3 zeros: seedProbe 60 -> Balanced320");
    const OverrunOutcome zeroOutcome = zeros.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(zeroOutcome.decision == OverrunDecision::NotTierBound &&
                     near(zeroOutcome.estimatedSavingsMs, areaSavings) &&
                     near(zeroOutcome.projectedMs, 40.0 - areaSavings),
                 "F3 zero probe falls back to the area ratio");
  }

  {
    // F4: invalid sample (session 0, ema 0 or budget 0) -> unconditional
    // step-down like the old overload, savings/projected -1.
    const ProgramOverrunSample invalidSamples[] = {
        overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 0.0, 3.0),
        overrunSample(GovernorTier::Balanced320, 0.0, 33.3, 11.0, 3.0),
        overrunSample(GovernorTier::Balanced320, 40.0, 0.0, 11.0, 3.0),
    };
    for (const ProgramOverrunSample &sample : invalidSamples) {
      KeyerAutoGovernor governor(testConfig());
      governor.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
      const OverrunOutcome outcome =
          governor.noteProgramBudgetOverrun(at(1), sample);
      ok &= expect(outcome.decision == OverrunDecision::SteppedDown,
                   "F4 invalid sample steps down unconditionally");
      ok &= expect(governor.tier() == GovernorTier::Performance256,
                   "F4 invalid sample lands at Performance256");
      ok &= expect(outcome.estimatedSavingsMs == -1.0 &&
                       outcome.projectedMs == -1.0,
                   "F4 invalid sample reports savings/projected -1");
    }
  }

  {
    // F5: inverted probes (256 slower than 320): ratio 14/11 is clamped to
    // 1.0 -> the session saves nothing, savings = tensor only = 1.08.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 14.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F5 probes 30/11/14 seed Balanced320");
    const OverrunOutcome outcome = governor.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 35.0, 33.3, 11.0, 3.0));
    ok &= expect(outcome.decision == OverrunDecision::NotTierBound,
                 "F5 inverted probes: not tier-bound");
    ok &= expect(near(outcome.estimatedSavingsMs, 1.08),
                 "F5 inverted probes clamp the ratio to 1.0");
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F5 tier unchanged");
  }

  {
    // F6: from Full512 with probes 512=24 (fits 26.67), 320=11: ratio 11/24
    // lies inside [0.390625, 1]. savings = 24 * (1 - 11/24) + 3 * (1 -
    // 0.390625) = 13 + 1.828125 = 14.828125.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(24.0, 11.0, 9.0);
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "F6 probes 24/11/9 seed Full512");
    // ema 50 -> projected 35.171875 > 33.3.
    const OverrunOutcome skipped = governor.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Full512, 50.0, 33.3, 24.0, 3.0));
    ok &= expect(skipped.decision == OverrunDecision::NotTierBound &&
                     governor.tier() == GovernorTier::Full512,
                 "F6 ema 50 is not tier-bound");
    ok &= expect(near(skipped.estimatedSavingsMs, 14.828125),
                 "F6 savings 14.828125 (ratio 11/24)");
    ok &= expect(near(skipped.projectedMs, 35.171875), "F6 projected 35.171875");
    // ema 45 -> projected 30.171875 <= 33.3.
    const OverrunOutcome stepped = governor.noteProgramBudgetOverrun(
        at(2), overrunSample(GovernorTier::Full512, 45.0, 33.3, 24.0, 3.0));
    ok &= expect(stepped.decision == OverrunDecision::SteppedDown &&
                     governor.tier() == GovernorTier::Balanced320,
                 "F6 ema 45 steps Full512 -> Balanced320");
    ok &= expect(near(stepped.projectedMs, 30.171875), "F6 projected 30.171875");
  }

  {
    // F7: the old overload is the "always" mode: it still steps down
    // unconditionally where the measured projection would skip (F2 inputs).
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 11.0);
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "F7 probes 30/11/11 seed Balanced320");
    governor.noteProgramBudgetOverrun(at(1));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "F7 old overload steps down unconditionally");
  }

  {
    // Sample overload: same Ignored cases as the old overload, and a
    // non-fused target keeps the unconditional step-down.
    KeyerAutoGovernor unseeded(testConfig());
    const OverrunOutcome ignored = unseeded.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Full512, 36.0, 33.3, 11.0, 3.0));
    ok &= expect(ignored.decision == OverrunDecision::Ignored &&
                     unseeded.tier() == GovernorTier::Full512,
                 "sample overload before seeding is ignored");

    KeyerAutoGovernor bottom(testConfig());
    bottom.seedProbe(120.0);  // Performance256
    const OverrunOutcome atBottom = bottom.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Performance256, 36.0, 33.3, 11.0, 3.0));
    ok &= expect(atBottom.decision == OverrunDecision::Ignored &&
                     bottom.tier() == GovernorTier::Performance256,
                 "sample overload at Performance256 is ignored");

    KeyerAutoGovernor noFused256(testConfig());
    noFused256.setFusedTierAvailability(true, true, false);
    noFused256.seedMeasuredProbes(30.0, 11.0, 9.0);  // Balanced320
    ok &= expect(noFused256.tier() == GovernorTier::Balanced320,
                 "no-256 config seeds Balanced320");
    const OverrunOutcome toLite = noFused256.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(toLite.decision == OverrunDecision::SteppedDown &&
                     noFused256.tier() == GovernorTier::Lite256 &&
                     toLite.projectedMs == -1.0,
                 "non-fused target keeps the unconditional step-down");
  }

  {
    // Stale sample: the tier moved between the overrun event (costs measured
    // at Full512) and the consuming frame (now Balanced320). The sample is
    // Ignored with NO state change, although its numbers alone would step
    // down (projected 30 - 1.08 = 28.92 <= 33.3 at Balanced320).
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    governor.maybeStepUp(at(0));                    // starts the dwell clock
    feed(governor, 5.0, 10, at(1));
    const double emaBefore = governor.inferenceEmaMs();
    const OverrunOutcome stale = governor.noteProgramBudgetOverrun(
        at(5), overrunSample(GovernorTier::Full512, 30.0, 33.3, 11.0, 3.0));
    ok &= expect(stale.decision == OverrunDecision::Ignored,
                 "stale sample (tier changed) is ignored");
    ok &= expect(stale.estimatedSavingsMs == -1.0 && stale.projectedMs == -1.0,
                 "stale sample reports no projection");
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "stale sample keeps the tier");
    ok &= expect(governor.inferenceEmaMs() == emaBefore,
                 "stale sample keeps the EMA");
    // Samples and dwell clock unchanged (same reasoning as F2): the climb at
    // the original 10s dwell still fires.
    governor.maybeStepUp(at(10));
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "stale sample keeps samples and dwell clock");

    // The same numbers tagged with the current tier do step down.
    KeyerAutoGovernor fresh(testConfig());
    fresh.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    const OverrunOutcome matching = fresh.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 30.0, 33.3, 11.0, 3.0));
    ok &= expect(matching.decision == OverrunDecision::SteppedDown &&
                     fresh.tier() == GovernorTier::Performance256 &&
                     near(matching.projectedMs, 28.92),
                 "matching tier tag steps down (projected 28.92)");

    // An untagged sample (default tierAtEvent = Off) never acts.
    KeyerAutoGovernor untagged(testConfig());
    untagged.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    ProgramOverrunSample untaggedSample;
    untaggedSample.programFrameEmaMs = 30.0;
    untaggedSample.budgetMs = 33.3;
    untaggedSample.sessionRunMs = 11.0;
    untaggedSample.tensorMs = 3.0;
    const OverrunOutcome untaggedOutcome =
        untagged.noteProgramBudgetOverrun(at(1), untaggedSample);
    ok &= expect(untaggedOutcome.decision == OverrunDecision::Ignored &&
                     untagged.tier() == GovernorTier::Balanced320,
                 "untagged sample is ignored");
  }

  {
    // F8: step-up estimates use the clamped measured probe ratio.
    // Probes 320=11, 256=11 at Performance256 with EMA 11: ratio clamped to
    // [1, 1.5625] -> 1.0 -> estimate 11.
    KeyerAutoGovernor equal(testConfig());
    equal.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    equal.noteProgramBudgetOverrun(at(1));       // -> Performance256
    feed(equal, 11.0, 10, at(2));
    ok &= expect(equal.tier() == GovernorTier::Performance256,
                 "F8 equal probes at Performance256");
    ok &= expect(near(equal.stepUpEstimateMs(), 11.0),
                 "F8 equal probes: step-up estimate 11");

    // Probes unknown -> area ratio: 11 * 1.5625 = 17.1875.
    KeyerAutoGovernor unknown(testConfig());
    unknown.seedProbe(120.0);  // Performance256
    feed(unknown, 11.0, 10, at(1));
    ok &= expect(near(unknown.stepUpEstimateMs(), 11.0 * 1.5625),
                 "F8 unknown probes: area estimate 17.1875");

    // Probes 320=16, 256=8 -> ratio 2.0 is clamped to the area 1.5625.
    KeyerAutoGovernor steep(testConfig());
    steep.seedMeasuredProbes(30.0, 16.0, 8.0);  // 16 <= 26.67 -> Balanced320
    ok &= expect(steep.tier() == GovernorTier::Balanced320,
                 "F8 probes 30/16/8 seed Balanced320");
    steep.noteProgramBudgetOverrun(at(1));  // -> Performance256
    feed(steep, 11.0, 10, at(2));
    ok &= expect(near(steep.stepUpEstimateMs(), 11.0 * 1.5625),
                 "F8 steep probes: ratio clamped to 1.5625");

    // Lite256 -> Performance256 keeps the async EMA 1:1 even with probes.
    KeyerAutoGovernor lite(testConfig());
    lite.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    feed(lite, 40.0, 10, at(1));                // -> Performance256
    feed(lite, 40.0, 10, at(2));                // -> Lite256
    ok &= expect(lite.tier() == GovernorTier::Lite256, "F8 lite reached");
    feed(lite, 15.0, 10, at(3));
    ok &= expect(near(lite.stepUpEstimateMs(), 15.0),
                 "F8 Lite256 -> Performance256 ratio stays 1.0");

    // Field case: 15ms program overhead shrinks the step-up threshold to
    // 0.8 * (33.33 - 15) = 14.67ms. With equal measured probes the 256 EMA
    // of 11ms climbs back to 320; the area estimate (17.19ms) never did.
    KeyerAutoGovernor recovers(testConfig());
    recovers.seedMeasuredProbes(30.0, 11.0, 11.0);  // Balanced320
    recovers.setFrameOverheadMs(15.0);
    recovers.noteProgramBudgetOverrun(at(1));  // -> Performance256
    feed(recovers, 11.0, 10, at(2));
    recovers.maybeStepUp(at(12));
    ok &= expect(recovers.tier() == GovernorTier::Balanced320,
                 "F8 measured probes let 256 climb back under overhead");

    KeyerAutoGovernor stuck(testConfig());
    stuck.seedProbe(120.0);  // Performance256, probes unknown
    stuck.setFrameOverheadMs(15.0);
    stuck.maybeStepUp(at(1));  // starts the dwell clock
    feed(stuck, 11.0, 10, at(2));
    stuck.maybeStepUp(at(12));
    ok &= expect(stuck.tier() == GovernorTier::Performance256,
                 "F8 area estimate keeps 256 under overhead (unchanged)");
  }

  {
    // F9: reset() clears the stored probes -> estimates fall back to area.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 11.0);
    governor.reset();
    governor.seedProbe(120.0);  // Performance256
    feed(governor, 11.0, 10, at(1));
    ok &= expect(near(governor.stepUpEstimateMs(), 11.0 * 1.5625),
                 "F9 reset clears the stored probes");
  }

  // ---- Round 2: program-frame step-up guard + measuredCostPolicy ----
  // Common setup (verifier's field model): probes 512=24, 320=13.7, 256=12.
  // Seeding with 5ms overhead: step-up threshold 0.8 * (33.33 - 5) = 22.67,
  // so 24 does not fit and 13.7 does -> Balanced320. The old overload then
  // steps to Performance256 (dwell clock starts at 1s), the overhead is set,
  // and 10 samples of 11.5ms give the Performance256 EMA 11.5.
  // At overhead 20: step-down threshold max(16.67, 33.33 - 20) = 16.67,
  // step-up threshold 0.8 * 16.67 = 13.33. Measured estimate 256 -> 320:
  // ratio 13.7/12 = 1.141667 (inside [1, 1.5625]) -> 11.5 * 1.141667 =
  // 13.129167 <= 13.33, so the estimate check passes. Guard extra:
  // (13.129167 - 11.5) + 3 * (1.5625 - 1) = 1.629167 + 1.6875 = 3.316667.
  const double kProgramBudgetMs = 1000.0 / 30.0;
  const auto governorAt256 = [](KeyerGovernorConfig config,
                                double overheadMs) {
    KeyerAutoGovernor governor(config);
    governor.setFrameOverheadMs(5.0);
    governor.seedMeasuredProbes(24.0, 13.7, 12.0);  // -> Balanced320
    governor.noteProgramBudgetOverrun(at(1));       // -> Performance256
    governor.setFrameOverheadMs(overheadMs);
    feed(governor, 11.5, 10, at(2));
    return governor;
  };

  {
    // (a) Program EMA 31.5 fits the 33.33 budget, but 31.5 + 3.316667 =
    // 34.816667 would not: the climb is blocked and NO state changes.
    KeyerAutoGovernor governor = governorAt256(testConfig(), 20.0);
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "R2a setup at Performance256");
    ok &= expect(near(governor.stepUpEstimateMs(), 11.5 * 13.7 / 12.0) &&
                     near(governor.stepUpEstimateMs(), 13.129166666666666),
                 "R2a measured estimate 13.129167");
    const double emaBefore = governor.inferenceEmaMs();
    governor.setProgramFrameState(31.5, kProgramBudgetMs, 3.0);
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "R2a guard blocks the 256 -> 320 climb");
    ok &= expect(governor.inferenceEmaMs() == emaBefore,
                 "R2a blocked climb keeps the EMA");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(10),
                 "R2a blocked climb keeps the step-up holdoff");
    // (b) on the SAME instance: program EMA 40 is over budget at both tiers
    // -> the climb happens at the same instant, which also proves the
    // blocked attempt kept the samples and the dwell clock.
    governor.setProgramFrameState(40.0, kProgramBudgetMs, 3.0);
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "R2b over-budget program frame climbs (same instance)");
  }

  {
    // (b) fresh instance: program EMA 40 > budget -> climbs as before.
    KeyerAutoGovernor governor = governorAt256(testConfig(), 20.0);
    governor.setProgramFrameState(40.0, kProgramBudgetMs, 3.0);
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "R2b program EMA 40 climbs");

    // Boundary: 29.9 + 3.316667 = 33.216667 <= 33.33 -> fits after the
    // climb -> climbs.
    KeyerAutoGovernor fits = governorAt256(testConfig(), 20.0);
    fits.setProgramFrameState(29.9, kProgramBudgetMs, 3.0);
    fits.maybeStepUp(at(12));
    ok &= expect(fits.tier() == GovernorTier::Balanced320,
                 "R2b climb that still fits the budget is taken");
  }

  {
    // (c) Unknown program state -> climbs as before: never set, EMA <= 0,
    // budget <= 0.
    KeyerAutoGovernor never = governorAt256(testConfig(), 20.0);
    never.maybeStepUp(at(12));
    ok &= expect(never.tier() == GovernorTier::Balanced320,
                 "R2c no program state -> climbs");

    KeyerAutoGovernor noEma = governorAt256(testConfig(), 20.0);
    noEma.setProgramFrameState(-1.0, kProgramBudgetMs, 3.0);
    noEma.maybeStepUp(at(12));
    ok &= expect(noEma.tier() == GovernorTier::Balanced320,
                 "R2c unknown program EMA -> climbs");

    KeyerAutoGovernor noBudget = governorAt256(testConfig(), 20.0);
    noBudget.setProgramFrameState(31.5, 0.0, 3.0);
    noBudget.maybeStepUp(at(12));
    ok &= expect(noBudget.tier() == GovernorTier::Balanced320,
                 "R2c unknown budget -> climbs");

    // reset() forgets the program state too.
    KeyerAutoGovernor resetState(testConfig());
    resetState.setProgramFrameState(31.5, kProgramBudgetMs, 3.0);
    resetState.reset();
    resetState.setFrameOverheadMs(5.0);
    resetState.seedMeasuredProbes(24.0, 13.7, 12.0);
    resetState.noteProgramBudgetOverrun(at(1));
    resetState.setFrameOverheadMs(20.0);
    feed(resetState, 11.5, 10, at(2));
    resetState.maybeStepUp(at(12));
    ok &= expect(resetState.tier() == GovernorTier::Balanced320,
                 "R2c reset() clears the program state");
  }

  {
    // (d) measuredCostPolicy = false: the pre-2026-10-17 governor.
    KeyerGovernorConfig rollback = testConfig();
    rollback.measuredCostPolicy = false;

    // d1, overhead 20: area estimate 11.5 * 1.5625 = 17.96875 > 13.33 ->
    // no climb (the origin/dev numbers), stored probes ignored.
    KeyerAutoGovernor d1 = governorAt256(rollback, 20.0);
    ok &= expect(near(d1.stepUpEstimateMs(), 17.96875),
                 "R2d policy off: area estimate 17.96875");
    d1.setProgramFrameState(40.0, kProgramBudgetMs, 3.0);
    d1.maybeStepUp(at(12));
    ok &= expect(d1.tier() == GovernorTier::Performance256,
                 "R2d policy off: area estimate does not fit at overhead 20");

    // d2, overhead 0 (step-up threshold 26.67): the area estimate 17.96875
    // fits and the guard is disabled -> climbs although 31.5 + extra would
    // exceed the budget with the policy on.
    KeyerAutoGovernor d2 = governorAt256(rollback, 0.0);
    d2.setProgramFrameState(31.5, kProgramBudgetMs, 3.0);
    d2.maybeStepUp(at(12));
    ok &= expect(d2.tier() == GovernorTier::Balanced320,
                 "R2d policy off: no program-frame guard");
    // Policy on, same inputs: estimate 13.129167 fits 26.67, but the guard
    // blocks (31.5 + 3.316667 = 34.816667 > 33.33).
    KeyerAutoGovernor d2on = governorAt256(testConfig(), 0.0);
    d2on.setProgramFrameState(31.5, kProgramBudgetMs, 3.0);
    d2on.maybeStepUp(at(12));
    ok &= expect(d2on.tier() == GovernorTier::Performance256,
                 "R2d policy on: same inputs are blocked");

    // d3: the overrun projection also falls back to the area ratio: probes
    // 30/11/9 at Balanced320 give 11 * 0.36 + 3 * 0.36 = 5.04 (not 3.08).
    KeyerAutoGovernor d3(rollback);
    d3.seedMeasuredProbes(30.0, 11.0, 9.0);  // Balanced320
    const OverrunOutcome d3Outcome = d3.noteProgramBudgetOverrun(
        at(1), overrunSample(GovernorTier::Balanced320, 40.0, 33.3, 11.0, 3.0));
    ok &= expect(near(d3Outcome.estimatedSavingsMs, 5.04) &&
                     d3Outcome.decision == OverrunDecision::NotTierBound,
                 "R2d policy off: overrun projection uses the area ratio");
  }

  // ---- Round 3: live-cost memory (A) + overrun wrong-estimate net (B) ----
  // Common path: overhead 5 (step-down threshold 28.33, step-up threshold
  // 22.67), probes 24/13.7/12 seed Balanced320; 10 samples of 12ms at 320
  // (EMA 12); the old overload steps to Performance256 and, leaving 320 with
  // 10 samples, stores live320 = 12; 10 samples of 11.5ms at 256.
  // Step-up estimate 256 -> 320: live ratio 12 / 11.5 = 1.043478 (inside
  // [1, 1.5625]) -> 11.5 * 1.043478 = 12.0 (probes alone: 11.5 * 13.7/12 =
  // 13.129167). 12.0 <= 22.67, dwell 11s at 12s -> the climb at 12s stores
  // live256 = 11.5 and starts the wrong-estimate window.
  const auto liveCycleTo256 = [](KeyerGovernorConfig config) {
    KeyerAutoGovernor governor(config);
    governor.setFrameOverheadMs(5.0);
    governor.seedMeasuredProbes(24.0, 13.7, 12.0);  // -> Balanced320
    feed(governor, 12.0, 10, at(1));
    governor.noteProgramBudgetOverrun(at(1));  // -> Performance256
    feed(governor, 11.5, 10, at(2));
    return governor;
  };
  // Overrun at 320 after the climb, with 30 samples of 12ms there (EMA 12,
  // the 30-sample watch has cleared): live ratio 11.5 / 12 = 0.958333 (inside
  // [0.64, 1]) -> savings = 12 * (1 - 0.958333) + 3 * 0.36 = 0.5 + 1.08 =
  // 1.58. Probes alone: 12 * (1 - 12/13.7) + 1.08 = 2.569051.

  {
    // (1) Live values override probes in the step-up estimate and in the
    // overrun projection.
    KeyerAutoGovernor governor = liveCycleTo256(testConfig());
    ok &= expect(governor.tier() == GovernorTier::Performance256,
                 "R3-1 at Performance256");
    ok &= expect(near(governor.stepUpEstimateMs(), 12.0),
                 "R3-1 step-up estimate uses live320/EMA (12, not 13.129)");
    governor.maybeStepUp(at(12));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "R3-1 climbs to Balanced320");
    feed(governor, 12.0, 30, at(13));
    // ema 35: live projection 35 - 1.58 = 33.42 > 33.33 -> NotTierBound
    // (the probe projection 35 - 2.569051 = 32.43 would have stepped down).
    const OverrunOutcome outcome = governor.noteProgramBudgetOverrun(
        at(14), overrunSample(GovernorTier::Balanced320, 35.0,
                              kProgramBudgetMs, 12.0, 3.0));
    ok &= expect(outcome.decision == OverrunDecision::NotTierBound &&
                     governor.tier() == GovernorTier::Balanced320,
                 "R3-1 live ratio keeps 320 (projected 33.42 > 33.33)");
    ok &= expect(near(outcome.estimatedSavingsMs, 1.58) &&
                     near(outcome.projectedMs, 33.42),
                 "R3-1 live savings 1.58, projected 33.42");
  }

  {
    // (2) Fewer than minSamples when leaving: nothing stored -> probes.
    KeyerAutoGovernor partial(testConfig());
    partial.setFrameOverheadMs(5.0);
    partial.seedMeasuredProbes(24.0, 13.7, 12.0);  // Balanced320
    feed(partial, 12.0, 9, at(1));                 // only 9 samples
    partial.noteProgramBudgetOverrun(at(1));       // -> Performance256
    feed(partial, 11.5, 10, at(2));
    ok &= expect(near(partial.stepUpEstimateMs(), 11.5 * 13.7 / 12.0),
                 "R3-2 9 samples store no live cost (probe estimate 13.129)");

    // A later short visit keeps the previously stored value: live320 = 12
    // survives a 5-sample visit at 20ms (else 11.5 * min(20/11.5, 1.5625) =
    // 17.96875).
    KeyerAutoGovernor keep = liveCycleTo256(testConfig());
    keep.maybeStepUp(at(12));                  // -> Balanced320
    feed(keep, 20.0, 5, at(13));               // 5 samples only
    keep.noteProgramBudgetOverrun(at(14));     // -> Performance256
    feed(keep, 11.5, 10, at(15));
    ok &= expect(keep.tier() == GovernorTier::Performance256 &&
                     near(keep.stepUpEstimateMs(), 12.0),
                 "R3-2 short visit keeps the stored live cost");
  }

  {
    // (3) reset() clears the live costs and the step-up time.
    KeyerAutoGovernor governor = liveCycleTo256(testConfig());
    governor.maybeStepUp(at(12));  // live256 stored, climb at 12s
    governor.reset();
    governor.setFrameOverheadMs(5.0);
    governor.seedMeasuredProbes(24.0, 13.7, 12.0);  // Balanced320, 0 samples
    governor.noteProgramBudgetOverrun(at(13));      // -> 256, nothing stored
    feed(governor, 11.5, 10, at(14));
    ok &= expect(near(governor.stepUpEstimateMs(), 11.5 * 13.7 / 12.0),
                 "R3-3 reset clears live costs (probe estimate 13.129)");

    KeyerAutoGovernor timer = liveCycleTo256(testConfig());
    timer.maybeStepUp(at(12));  // climb at 12s
    timer.reset();
    timer.setFrameOverheadMs(5.0);
    timer.seedMeasuredProbes(24.0, 13.7, 12.0);  // Balanced320
    feed(timer, 12.0, 30, at(13));
    // 2s after the pre-reset climb: probe projection 34.5 - 2.569051 =
    // 31.93 -> SteppedDown, but no climb is remembered -> holdoff stays 10s.
    const OverrunOutcome outcome = timer.noteProgramBudgetOverrun(
        at(14), overrunSample(GovernorTier::Balanced320, 34.5,
                              kProgramBudgetMs, 12.0, 3.0));
    ok &= expect(outcome.decision == OverrunDecision::SteppedDown &&
                     timer.stepUpHoldoff() == std::chrono::seconds(10),
                 "R3-3 reset clears the step-up time (no net)");
  }

  {
    // (4) Wrong-estimate net. ema 34.5 at 320 after the climb: live
    // projection 34.5 - 1.58 = 32.92 <= 33.33 -> SteppedDown.
    const ProgramOverrunSample stepDownSample = overrunSample(
        GovernorTier::Balanced320, 34.5, kProgramBudgetMs, 12.0, 3.0);

    // 20s after the climb (inside 30s), watch already cleared: 10s -> 20s.
    KeyerAutoGovernor inside = liveCycleTo256(testConfig());
    inside.maybeStepUp(at(12));
    feed(inside, 12.0, 30, at(13));
    const OverrunOutcome insideOutcome =
        inside.noteProgramBudgetOverrun(at(32), stepDownSample);
    ok &= expect(insideOutcome.decision == OverrunDecision::SteppedDown &&
                     inside.tier() == GovernorTier::Performance256,
                 "R3-4 measured step-down inside the window");
    ok &= expect(inside.stepUpHoldoff() == std::chrono::seconds(20),
                 "R3-4 net doubles the holdoff inside 30s");

    // Exactly 30s: still inside (<= window).
    KeyerAutoGovernor edge = liveCycleTo256(testConfig());
    edge.maybeStepUp(at(12));
    feed(edge, 12.0, 30, at(13));
    edge.noteProgramBudgetOverrun(at(42), stepDownSample);
    ok &= expect(edge.stepUpHoldoff() == std::chrono::seconds(20),
                 "R3-4 net doubles at exactly 30s");

    // 31s: outside the window -> no doubling.
    KeyerAutoGovernor outside = liveCycleTo256(testConfig());
    outside.maybeStepUp(at(12));
    feed(outside, 12.0, 30, at(13));
    const OverrunOutcome outsideOutcome =
        outside.noteProgramBudgetOverrun(at(43), stepDownSample);
    ok &= expect(outsideOutcome.decision == OverrunDecision::SteppedDown &&
                     outside.stepUpHoldoff() == std::chrono::seconds(10),
                 "R3-4 no doubling outside the window");

    // Watch still armed (10 samples < 30): stepDown() doubles once; the net
    // does not double again (20s, not 40s).
    KeyerAutoGovernor armed = liveCycleTo256(testConfig());
    armed.maybeStepUp(at(12));
    feed(armed, 12.0, 10, at(13));
    armed.noteProgramBudgetOverrun(at(14), stepDownSample);
    ok &= expect(armed.tier() == GovernorTier::Performance256 &&
                     armed.stepUpHoldoff() == std::chrono::seconds(20),
                 "R3-4 one doubling per wrong estimate");
  }

  {
    // (4b) Any step-down consumes the remembered climb. Default config
    // (thresholds 33.33 / 26.67): probes 30/11/9 seed Balanced320; dwell
    // clock starts at 0s; 10 x 5ms -> EMA 5. Climb 320 -> 512 at 10s:
    // estimate 5 * clamp(30/11 = 2.727, [1, 2.56]) = 12.8 <= 26.67 (no live
    // 512 cost yet -> probes); the climb time is 10s.
    KeyerAutoGovernor governor(testConfig());
    governor.seedMeasuredProbes(30.0, 11.0, 9.0);  // Balanced320
    governor.maybeStepUp(at(0));                   // starts the dwell clock
    feed(governor, 5.0, 10, at(1));
    governor.maybeStepUp(at(10));
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "R3-4b climbs 320 -> 512 at 10s");
    // 30 x 10ms at 512 clear the 30-sample watch (EMA 10). Two 100ms samples:
    // EMA 0.2*100 + 0.8*10 = 28 (<= 33.33), then 0.2*100 + 0.8*28 = 42.4 >
    // 33.33 with 32 samples -> sample-driven step-down 512 -> 320 at 11s;
    // the watch is already cleared, so the holdoff stays 10s.
    feed(governor, 10.0, 30, at(11));
    feed(governor, 100.0, 2, at(11));
    ok &= expect(governor.tier() == GovernorTier::Balanced320 &&
                     governor.stepUpHoldoff() == std::chrono::seconds(10),
                 "R3-4b sample-driven step-down without doubling");
    // Measured overrun at 320 at 20s (10s after the climb, inside 30s): no
    // live 256 cost -> probe ratio 9/11 -> savings 11 * (1 - 9/11) + 3 *
    // 0.36 = 2 + 1.08 = 3.08, ema 36 -> projected 32.92 <= 33.3 ->
    // SteppedDown. The climb was consumed by the sample-driven step-down, so
    // the net must NOT double (10s, not 20s).
    const OverrunOutcome outcome = governor.noteProgramBudgetOverrun(
        at(20), overrunSample(GovernorTier::Balanced320, 36.0, 33.3, 11.0, 3.0));
    ok &= expect(outcome.decision == OverrunDecision::SteppedDown &&
                     governor.tier() == GovernorTier::Performance256 &&
                     near(outcome.projectedMs, 32.92),
                 "R3-4b measured step-down inside the window");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(10),
                 "R3-4b any step-down consumes the remembered climb");
  }

  {
    // (5) measuredCostPolicy = false: no live memory, no net (old numbers).
    KeyerGovernorConfig rollback = testConfig();
    rollback.measuredCostPolicy = false;
    KeyerAutoGovernor governor = liveCycleTo256(rollback);
    // Area estimate 11.5 * 1.5625 = 17.96875 (live320 = 12 not stored).
    ok &= expect(near(governor.stepUpEstimateMs(), 17.96875),
                 "R3-5 policy off: area estimate, no live memory");
    governor.maybeStepUp(at(12));  // 17.96875 <= 22.67 -> climbs
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "R3-5 policy off climbs on the area estimate");
    feed(governor, 12.0, 30, at(13));
    // Area projection: 12 * 0.36 + 3 * 0.36 = 5.4 -> 34.5 - 5.4 = 29.1 ->
    // SteppedDown, 20s after the climb, but no net -> holdoff stays 10s.
    const OverrunOutcome outcome = governor.noteProgramBudgetOverrun(
        at(32), overrunSample(GovernorTier::Balanced320, 34.5,
                              kProgramBudgetMs, 12.0, 3.0));
    ok &= expect(outcome.decision == OverrunDecision::SteppedDown &&
                     near(outcome.estimatedSavingsMs, 5.4),
                 "R3-5 policy off: area projection (savings 5.4)");
    ok &= expect(governor.stepUpHoldoff() == std::chrono::seconds(10),
                 "R3-5 policy off: no wrong-estimate net");
    feed(governor, 11.5, 10, at(33));
    ok &= expect(near(governor.stepUpEstimateMs(), 17.96875),
                 "R3-5 policy off: still the area estimate after 320 visit");
  }

  return ok ? 0 : 1;
}
