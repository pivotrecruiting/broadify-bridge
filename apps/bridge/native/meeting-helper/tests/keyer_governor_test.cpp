#include "keyer/keyer_governor.h"

#include <chrono>
#include <iostream>
#include <string>

using broadify::meeting::GovernorTier;
using broadify::meeting::KeyerAutoGovernor;
using broadify::meeting::KeyerGovernorConfig;

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

  return ok ? 0 : 1;
}
