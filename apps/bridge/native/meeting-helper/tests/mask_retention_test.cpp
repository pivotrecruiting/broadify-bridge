#include "pipeline/mask_retention.h"

#include <cstdint>
#include <iostream>

using broadify::meeting::MaskRetention;
using broadify::meeting::MaskRetentionConfig;
using broadify::meeting::MaskRetentionDecision;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "mask_retention_test failed: " << what << std::endl;
  }
  return condition;
}

constexpr uint64_t kMsToNs = 1000000ull;

}  // namespace

int main() {
  bool ok = true;
  const double configuredMaxAge = 150.0;

  {
    // Gate adaptation: a healthy-but-slow keyer publishing every ~80ms lifts
    // the effective gate to 2.5 * 80 = 200ms, so ages around 160-190ms (the
    // field flapping zone) stay Apply instead of oscillating around 150.
    MaskRetention retention;
    ok &= expect(retention.effectiveMaxAgeMs(configuredMaxAge) == 150.0,
                 "no cadence yet: gate equals the configured max age");
    // Feed a stable 80ms publish cadence (one decide per publish).
    uint64_t frameTs = 1000ull * kMsToNs;
    uint64_t publishTs = 500ull * kMsToNs;
    for (int i = 0; i < 40; ++i) {
      frameTs += 80ull * kMsToNs;
      publishTs += 80ull * kMsToNs;
      const MaskRetentionDecision decision =
          retention.decide(frameTs, publishTs, 40.0, configuredMaxAge);
      ok &= expect(decision == MaskRetentionDecision::Apply,
                   "fresh mask applies during cadence learning");
    }
    const double gate = retention.effectiveMaxAgeMs(configuredMaxAge);
    ok &= expect(gate > 195.0 && gate < 205.0,
                 "gate adapts to 2.5x the 80ms publish cadence");
    // Field zone: 180ms old mask is now inside the gate.
    frameTs += 180ull * kMsToNs;
    ok &= expect(retention.decide(frameTs, publishTs, 180.0, configuredMaxAge) ==
                     MaskRetentionDecision::Apply,
                 "field-zone age (180ms) applies with the adapted gate");
  }

  {
    // Hold window: over the gate but under the hard cap keeps the mask
    // (StaleHold), it never flips straight to Passthrough.
    MaskRetention retention;
    uint64_t frameTs = 1000ull * kMsToNs;
    const uint64_t publishTs = 990ull * kMsToNs;
    ok &= expect(retention.decide(frameTs, publishTs, 10.0, configuredMaxAge) ==
                     MaskRetentionDecision::Apply,
                 "fresh mask applies");
    for (double age = 200.0; age <= 1400.0; age += 100.0) {
      frameTs += 100ull * kMsToNs;
      ok &= expect(retention.decide(frameTs, publishTs, age, configuredMaxAge) ==
                       MaskRetentionDecision::StaleHold,
                   "over-gate under-cap age holds the mask");
    }
  }

  {
    // Hard cap with hysteresis: passthrough only engages after 5 consecutive
    // frames over the cap; recovery on a fresh mask is immediate.
    MaskRetention retention;
    uint64_t frameTs = 1000ull * kMsToNs;
    uint64_t publishTs = 990ull * kMsToNs;
    retention.decide(frameTs, publishTs, 10.0, configuredMaxAge);
    double age = 1600.0;  // beyond the 1500ms hard cap
    for (int frame = 0; frame < 4; ++frame) {
      frameTs += 33ull * kMsToNs;
      age += 33.0;
      ok &= expect(retention.decide(frameTs, publishTs, age, configuredMaxAge) ==
                       MaskRetentionDecision::StaleHold,
                   "over-cap frames below the streak still hold");
    }
    frameTs += 33ull * kMsToNs;
    age += 33.0;
    ok &= expect(retention.decide(frameTs, publishTs, age, configuredMaxAge) ==
                     MaskRetentionDecision::Passthrough,
                 "5th consecutive over-cap frame enters passthrough");
    frameTs += 33ull * kMsToNs;
    age += 33.0;
    ok &= expect(retention.decide(frameTs, publishTs, age, configuredMaxAge) ==
                     MaskRetentionDecision::Passthrough,
                 "passthrough persists while the mask stays over the cap");
    // Fresh mask -> immediate recovery.
    publishTs = frameTs - 5ull * kMsToNs;
    ok &= expect(retention.decide(frameTs, publishTs, 5.0, configuredMaxAge) ==
                     MaskRetentionDecision::Apply,
                 "fresh mask leaves passthrough immediately");
  }

  {
    // Same-frame re-evaluation (a fresher pair published mid-frame) must not
    // advance the passthrough streak twice per program frame.
    MaskRetention retention;
    uint64_t frameTs = 1000ull * kMsToNs;
    const uint64_t publishTs = 990ull * kMsToNs;
    retention.decide(frameTs, publishTs, 10.0, configuredMaxAge);
    for (int frame = 0; frame < 4; ++frame) {
      frameTs += 33ull * kMsToNs;
      // Two evaluations of the SAME camera frame count as one streak step.
      retention.decide(frameTs, publishTs, 1600.0, configuredMaxAge);
      ok &= expect(retention.decide(frameTs, publishTs, 1600.0,
                                    configuredMaxAge) ==
                       MaskRetentionDecision::StaleHold,
                   "double evaluation of one frame does not double-count");
    }
    frameTs += 33ull * kMsToNs;
    ok &= expect(retention.decide(frameTs, publishTs, 1600.0, configuredMaxAge) ==
                     MaskRetentionDecision::Passthrough,
                 "streak still completes on the 5th distinct frame");
  }

  {
    // The adaptive gate is capped at the hard cap, and implausible publish
    // gaps (worker restart) do not inflate the EMA.
    MaskRetentionConfig config;
    config.hardCapMs = 400.0;
    MaskRetention retention(config);
    uint64_t frameTs = 1000ull * kMsToNs;
    uint64_t publishTs = 900ull * kMsToNs;
    for (int i = 0; i < 30; ++i) {
      frameTs += 300ull * kMsToNs;
      publishTs += 300ull * kMsToNs;  // 2.5 * 300 = 750 > hardCap 400
      retention.decide(frameTs, publishTs, 50.0, configuredMaxAge);
    }
    ok &= expect(retention.effectiveMaxAgeMs(configuredMaxAge) == 400.0,
                 "adaptive gate is capped at the hard cap");
    const double emaBefore = retention.intervalEmaMs();
    frameTs += 60000ull * kMsToNs;
    publishTs += 60000ull * kMsToNs;  // 60s outage: implausible interval
    retention.decide(frameTs, publishTs, 50.0, configuredMaxAge);
    ok &= expect(retention.intervalEmaMs() == emaBefore,
                 "implausible publish gap is ignored by the EMA");
  }

  {
    // reset() forgets cadence and hysteresis state.
    MaskRetention retention;
    uint64_t frameTs = 1000ull * kMsToNs;
    uint64_t publishTs = 500ull * kMsToNs;
    for (int i = 0; i < 20; ++i) {
      frameTs += 200ull * kMsToNs;
      publishTs += 200ull * kMsToNs;
      retention.decide(frameTs, publishTs, 40.0, configuredMaxAge);
    }
    ok &= expect(retention.intervalEmaMs() > 0.0, "EMA learned before reset");
    retention.reset();
    ok &= expect(retention.intervalEmaMs() < 0.0, "reset clears the EMA");
    ok &= expect(retention.effectiveMaxAgeMs(configuredMaxAge) == 150.0,
                 "reset restores the configured gate");
  }

  return ok ? 0 : 1;
}
