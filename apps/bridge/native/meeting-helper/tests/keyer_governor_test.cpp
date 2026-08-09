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
    governor.seedProbe(30.0);  // 30 <= 33.3 -> full quality fits
    ok &= expect(governor.tier() == GovernorTier::Full512, "seed 30ms -> Full512");
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
    // Off threshold: at Lite256 a smoothed cost above offInferenceMs (120ms)
    // turns the keyer off after a full sample window.
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
    // Off re-probes to Lite256 after the backoff, accepted without a probe.
    governor.maybeReprobe(at(100));  // backoff started at the off transition
    ok &= expect(governor.tier() == GovernorTier::Lite256,
                 "Off climbs back to Lite256 after backoff");
    ok &= expect(!governor.probing(), "Off -> Lite256 needs no probe");
  }

  {
    // Re-probe: backoff doubles on a failed probe and resets once one holds.
    KeyerAutoGovernor governor(testConfig());
    feed(governor, 40.0, 10, at(0));  // degrade Full512 -> Balanced320 at t=0
    ok &= expect(governor.tier() == GovernorTier::Balanced320, "degraded");
    governor.maybeReprobe(at(30));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "no re-probe before the base interval");
    governor.maybeReprobe(at(60));
    ok &= expect(governor.tier() == GovernorTier::Full512, "re-probe climbs a tier");
    ok &= expect(governor.probing(), "climb is a probe");
    feed(governor, 40.0, 10, at(61));  // probe fails
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "failed probe falls back");
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(120),
                 "failed probe doubles the backoff");
    governor.maybeReprobe(at(61 + 60));
    ok &= expect(governor.tier() == GovernorTier::Balanced320,
                 "doubled backoff blocks the 60s retry");
    governor.maybeReprobe(at(61 + 120));
    ok &= expect(governor.tier() == GovernorTier::Full512,
                 "re-probe fires after the doubled backoff");
    feed(governor, 20.0, 30, at(182));  // probe holds for stableSamples
    ok &= expect(governor.tier() == GovernorTier::Full512, "held probe keeps tier");
    ok &= expect(!governor.probing(), "held probe ends probing");
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(60),
                 "held probe resets the backoff to base");
  }

  {
    // Backoff is capped at the max interval.
    KeyerGovernorConfig config = testConfig();
    config.reprobeMaxInterval = std::chrono::seconds(120);
    KeyerAutoGovernor governor(config);
    feed(governor, 40.0, 10, at(0));
    int now = 0;
    for (int round = 0; round < 4; ++round) {
      now += 600;
      governor.maybeReprobe(at(now));
      feed(governor, 40.0, 10, at(now));  // every probe fails
    }
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(120),
                 "backoff is capped at reprobeMaxInterval");
  }

  {
    // Testing override replaces the step-down threshold.
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
    // reset() returns to a clean, unseeded Full512.
    KeyerAutoGovernor governor(testConfig());
    governor.seedProbe(500.0);
    ok &= expect(governor.seeded(), "seeded before reset");
    governor.reset();
    ok &= expect(governor.tier() == GovernorTier::Full512, "reset -> Full512");
    ok &= expect(!governor.seeded(), "reset clears seeded");
    ok &= expect(!governor.wantsOff() && !governor.wantsAsyncLite(),
                 "reset clears degradation");
    ok &= expect(governor.reprobeInterval() == std::chrono::seconds(60),
                 "reset restores the base backoff");
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
    ok &= expect(std::string(governor.pipelineModeLabel(false)) == "off",
                 "Off label off");
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
