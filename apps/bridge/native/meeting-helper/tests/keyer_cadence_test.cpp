#include "pipeline/keyer_cadence.h"

#include <chrono>
#include <cstdint>
#include <iostream>

using broadify::meeting::CadenceDecision;
using broadify::meeting::FusedCadenceConfig;
using broadify::meeting::FusedCadenceController;
using broadify::meeting::LumaThumb;
using broadify::meeting::downsampleLumaThumb;
using broadify::meeting::meanAbsLumaDiff;

namespace {

using TimePoint = FusedCadenceController::TimePoint;

constexpr uint64_t kFrameNs = 33'333'333ull;  // ~30fps
constexpr double kLowMotion = 0.0;

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "keyer_cadence_test failed: " << what << std::endl;
  }
  return condition;
}

FusedCadenceConfig testConfig() {
  FusedCadenceConfig config;
  config.frameBudgetMs = 1000.0 / 30.0;  // 33.33ms, headroom 0.8 -> 26.67ms
  return config;
}

TimePoint at(int ms) {
  return TimePoint{} + std::chrono::milliseconds(ms);
}

}  // namespace

int main() {
  bool ok = true;

  {
    // N derivation from the inference-cost EMA (budget*headroom = 26.67ms).
    FusedCadenceController cadence(testConfig());
    ok &= expect(cadence.currentN() == 1, "no samples -> N=1");
    cadence.onInferenceCompleted(kFrameNs, 20.0, at(0));
    ok &= expect(cadence.currentN() == 1, "20ms -> N=1 (fits headroom)");
    FusedCadenceController slow(testConfig());
    slow.onInferenceCompleted(kFrameNs, 50.0, at(0));
    ok &= expect(slow.currentN() == 2, "50ms -> N=2");
    FusedCadenceController slower(testConfig());
    slower.onInferenceCompleted(kFrameNs, 100.0, at(0));
    ok &= expect(slower.currentN() == 4, "100ms -> N=4");
    FusedCadenceController slowest(testConfig());
    slowest.onInferenceCompleted(kFrameNs, 500.0, at(0));
    ok &= expect(slowest.currentN() == 4, "500ms -> N clamped to maxN=4");
  }

  {
    // Skip/run pattern: with N=2 every second frame infers; the EMA converges
    // (weight 0.2) so N drops back to 1 once inference gets fast again.
    FusedCadenceController cadence(testConfig());
    uint64_t ts = kFrameNs;
    cadence.onInferenceCompleted(ts, 50.0, at(0));  // N=2
    ts += kFrameNs;
    CadenceDecision d = cadence.decide(ts, kLowMotion, true, at(33));
    ok &= expect(!d.runInference, "frame 1 after inference skips (N=2)");
    ts += kFrameNs;
    d = cadence.decide(ts, kLowMotion, true, at(66));
    ok &= expect(d.runInference, "frame 2 after inference runs (N=2)");
    // Fast samples pull the EMA under the headroom -> back to every frame.
    for (int i = 0; i < 12; ++i) {
      cadence.onInferenceCompleted(ts, 10.0, at(66));
    }
    ok &= expect(cadence.currentN() == 1, "fast EMA returns to N=1");
  }

  {
    // Forced-inference triggers.
    FusedCadenceController cadence(testConfig());
    uint64_t ts = kFrameNs;
    cadence.onInferenceCompleted(ts, 100.0, at(0));  // N=4
    // (a) No valid retained mask -> always infer, age reported as 0.
    CadenceDecision d = cadence.decide(ts + kFrameNs, kLowMotion, false, at(33));
    ok &= expect(d.runInference, "no valid mask forces inference");
    ok &= expect(d.maskAgeMs == 0.0, "no valid mask -> age 0");
    // (b) Motion above the threshold -> infer even though N allows a skip.
    d = cadence.decide(ts + kFrameNs, 20.0, true, at(33));
    ok &= expect(d.runInference, "motion above threshold forces inference");
    // (c) Mask age above maxMaskAgeMs (150) -> infer. 6 frames = ~200ms.
    FusedCadenceController aged(testConfig());
    aged.onInferenceCompleted(kFrameNs, 100.0, at(0));  // N=4
    const uint64_t oldTs = kFrameNs + 6ull * kFrameNs;
    d = aged.decide(oldTs, kLowMotion, true, at(200));
    ok &= expect(d.runInference, "over-age mask forces inference");
    ok &= expect(d.maskAgeMs > 150.0, "over-age decision reports the real age");
  }

  {
    // Pinning: N pinned to 3 ignores the EMA; run exactly every third frame.
    FusedCadenceConfig config = testConfig();
    config.pinnedN = 3;
    FusedCadenceController cadence(config);
    uint64_t ts = kFrameNs;
    cadence.onInferenceCompleted(ts, 5.0, at(0));  // fast, would be N=1 in auto
    ok &= expect(cadence.currentN() == 3, "pinned N wins over EMA");
    int runs = 0;
    for (int frame = 1; frame <= 6; ++frame) {
      ts += kFrameNs;
      const CadenceDecision d = cadence.decide(ts, kLowMotion, true, at(frame * 33));
      if (d.runInference) {
        ++runs;
        cadence.onInferenceCompleted(ts, 5.0, at(frame * 33));
      }
    }
    ok &= expect(runs == 2, "pinned N=3 runs every third frame (2 of 6)");
  }

  {
    // Cadence inert (BROADIFY_MEETING_KEYER_CADENCE=0): always infer.
    FusedCadenceConfig config = testConfig();
    config.enabled = false;
    FusedCadenceController cadence(config);
    cadence.onInferenceCompleted(kFrameNs, 500.0, at(0));
    const CadenceDecision d =
        cadence.decide(kFrameNs + kFrameNs, kLowMotion, true, at(33));
    ok &= expect(d.runInference, "disabled cadence always infers");
    ok &= expect(cadence.currentN() == 1, "disabled cadence reports N=1");
  }

  {
    // Honest maskAgeMs on skipped frames (ns -> ms of the frame-ts delta).
    FusedCadenceController cadence(testConfig());
    const uint64_t inferredTs = 1'000'000'000ull;
    cadence.onInferenceCompleted(inferredTs, 50.0, at(0));  // N=2
    const CadenceDecision d =
        cadence.decide(inferredTs + kFrameNs, kLowMotion, true, at(33));
    ok &= expect(!d.runInference, "skip frame for age check");
    ok &= expect(d.maskAgeMs > 33.0 && d.maskAgeMs < 34.0,
                 "skipped frame books the real mask age (~33.3ms)");
  }

  {
    // A run decision whose inference never completes keeps forcing runs.
    FusedCadenceController cadence(testConfig());
    cadence.onInferenceCompleted(kFrameNs, 50.0, at(0));  // N=2
    uint64_t ts = kFrameNs + kFrameNs;
    CadenceDecision d = cadence.decide(ts, kLowMotion, true, at(33));
    ok &= expect(!d.runInference, "first frame skips");
    ts += kFrameNs;
    d = cadence.decide(ts, kLowMotion, true, at(66));
    ok &= expect(d.runInference, "second frame runs");
    // Inference failed -> no onInferenceCompleted. Next frames must run.
    ts += kFrameNs;
    d = cadence.decide(ts, kLowMotion, true, at(100));
    ok &= expect(d.runInference, "failed inference keeps forcing runs");
  }

  {
    // reset() clears the retained state.
    FusedCadenceController cadence(testConfig());
    cadence.onInferenceCompleted(kFrameNs, 100.0, at(0));
    cadence.reset();
    ok &= expect(cadence.currentN() == 1, "reset clears the EMA");
    const CadenceDecision d =
        cadence.decide(2ull * kFrameNs, kLowMotion, true, at(33));
    ok &= expect(d.runInference, "reset forces a fresh inference");
  }

  {
    // Luma thumb helpers: identical frames -> 0 diff; half-inverted -> large.
    constexpr uint32_t width = 320u;
    constexpr uint32_t height = 180u;
    std::vector<uint8_t> frameA(static_cast<size_t>(width) * height * 4u, 200u);
    std::vector<uint8_t> frameB = frameA;
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width / 2u; ++x) {
        const size_t offset = (static_cast<size_t>(y) * width + x) * 4u;
        frameB[offset + 0u] = 10u;
        frameB[offset + 1u] = 10u;
        frameB[offset + 2u] = 10u;
      }
    }
    LumaThumb thumbA;
    LumaThumb thumbB;
    downsampleLumaThumb(frameA.data(), width, height, thumbA);
    downsampleLumaThumb(frameB.data(), width, height, thumbB);
    ok &= expect(thumbA.valid() && thumbB.valid(), "thumbs are valid");
    ok &= expect(thumbA.width == 64u && thumbA.height == 36u,
                 "default thumb size 64x36");
    ok &= expect(meanAbsLumaDiff(thumbA, thumbA) == 0.0,
                 "identical thumbs diff 0");
    const double diff = meanAbsLumaDiff(thumbA, thumbB);
    ok &= expect(diff > 80.0, "half-frame change yields a large diff");
    LumaThumb empty;
    ok &= expect(meanAbsLumaDiff(thumbA, empty) == 0.0,
                 "invalid thumb diff is 0");
  }

  return ok ? 0 : 1;
}
