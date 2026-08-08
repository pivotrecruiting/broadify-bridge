#pragma once

#include <chrono>
#include <cstdint>
#include <vector>

namespace broadify::meeting {

struct CadenceDecision {
  bool runInference = true;
  // Honest age of the retained mask relative to the current frame (0 when a
  // fresh inference runs / no retained mask exists).
  double maskAgeMs = 0.0;
};

struct FusedCadenceConfig {
  // One program frame of budget (1000/fps).
  double frameBudgetMs = 1000.0 / 30.0;
  // Fraction of the budget one inference may consume before the cadence
  // spreads it over multiple frames (0.8 keeps ~20% compositing headroom).
  double headroom = 0.8;
  // Upper bound for the auto inference interval (in frames).
  int maxN = 4;
  // A retained mask older than this is always refreshed.
  double maxMaskAgeMs = 150.0;
  // Motion threshold on the SAME scale as the pipeline's kEmaMotionLow (6.0) /
  // kEmaMotionHigh (30.0) constants in frame_pipeline.cpp: those classify the
  // mean absolute ALPHA difference (0..255) between successive masks as
  // static (<6) vs clear motion (>30). The cadence's motion score is the mean
  // absolute LUMA difference (0..255) between ~64x36 downsamples of the
  // current camera frame and the last-inferred frame - the same
  // mean-abs-diff-of-bytes scale. 9.0 sits just above the "static" band, so
  // sensor noise keeps the cadence, while genuine subject motion forces a
  // fresh inference immediately.
  double motionThreshold = 9.0;
  // EMA weight of the newest inference-cost sample.
  double emaWeight = 0.2;
  // 0 = auto-derive N from the smoothed inference cost; >= 1 pins N
  // (1 = infer every frame).
  int pinnedN = 0;
  // false = cadence inert, infer every frame (BROADIFY_MEETING_KEYER_CADENCE=0).
  bool enabled = true;
};

// Inference cadence for the Windows fused keyer: instead of blocking every
// program frame on a synchronous inference, run the model every Nth frame and
// reuse the retained raw matte in between (the guided edge refine still runs
// per frame against the CURRENT camera image). Pure logic, stdlib only, time
// injected; never changes the inference resolution (that is the governor's
// job).
class FusedCadenceController {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  FusedCadenceController() = default;
  explicit FusedCadenceController(const FusedCadenceConfig &config);

  // Per-frame decision. motionScore: mean abs luma diff vs the last-inferred
  // frame (see motionThreshold); hasValidMask: a reusable retained mask
  // exists. Forces inference when there is no valid mask, the retained mask
  // exceeded maxMaskAgeMs, motion exceeded the threshold, or N frames passed
  // since the last completed inference.
  CadenceDecision decide(uint64_t frameTsNs, double motionScore,
                         bool hasValidMask, TimePoint now);

  // Books a COMPLETED (successful) inference for frame frameTsNs.
  void onInferenceCompleted(uint64_t frameTsNs, double inferenceMs,
                            TimePoint now);

  // Effective inference interval in frames (1 = every frame).
  int currentN() const;
  double inferenceEmaMs() const { return emaMs_; }

  void reset();

 private:
  FusedCadenceConfig config_{};
  double emaMs_ = -1.0;
  uint64_t lastInferredTsNs_ = 0u;
  int framesSinceInference_ = 0;
};

// Motion-score helpers: a ~64x36 nearest-neighbor luma downsample of an RGBA
// frame, cheap enough to run per program frame, with reusable allocation.
struct LumaThumb {
  uint32_t width = 0u;
  uint32_t height = 0u;
  std::vector<uint8_t> luma;

  bool valid() const {
    return width > 0u && height > 0u &&
           luma.size() == static_cast<size_t>(width) * height;
  }
};

void downsampleLumaThumb(const uint8_t *rgba, uint32_t width, uint32_t height,
                         LumaThumb &out, uint32_t thumbWidth = 64u,
                         uint32_t thumbHeight = 36u);

// Mean absolute luma difference (0..255) between two equally sized thumbs;
// returns 0.0 when either thumb is invalid or the sizes differ.
double meanAbsLumaDiff(const LumaThumb &a, const LumaThumb &b);

}  // namespace broadify::meeting
