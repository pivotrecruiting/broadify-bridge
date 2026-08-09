#include "pipeline/keyer_cadence.h"

#include <algorithm>
#include <cmath>

namespace broadify::meeting {

FusedCadenceController::FusedCadenceController(const FusedCadenceConfig &config)
    : config_(config) {}

int FusedCadenceController::currentN() const {
  if (!config_.enabled) {
    return 1;
  }
  if (config_.pinnedN >= 1) {
    return config_.pinnedN;
  }
  if (emaMs_ <= 0.0) {
    return 1;
  }
  const double budget = config_.frameBudgetMs * config_.headroom;
  if (budget <= 0.0) {
    return 1;
  }
  const int n = static_cast<int>(std::ceil(emaMs_ / budget));
  return std::clamp(n, 1, std::max(1, config_.maxN));
}

CadenceDecision FusedCadenceController::decide(uint64_t frameTsNs,
                                               double motionScore,
                                               bool hasValidMask,
                                               TimePoint now) {
  (void)now;  // Time-based rules use frame timestamps; kept for symmetry.
  if (!config_.enabled) {
    return CadenceDecision{true, 0.0};
  }
  const bool hasReference = hasValidMask && lastInferredTsNs_ != 0u &&
                            frameTsNs >= lastInferredTsNs_;
  const double maskAgeMs =
      hasReference
          ? static_cast<double>(frameTsNs - lastInferredTsNs_) / 1000000.0
          : 0.0;
  // Count the current frame; onInferenceCompleted resets, so a decision of
  // "run" whose inference then FAILS keeps forcing inference until one lands.
  ++framesSinceInference_;
  const int n = currentN();
  if (!hasReference || n <= 1 || framesSinceInference_ >= n ||
      maskAgeMs > config_.maxMaskAgeMs ||
      motionScore > config_.motionThreshold) {
    return CadenceDecision{true, maskAgeMs};
  }
  return CadenceDecision{false, maskAgeMs};
}

void FusedCadenceController::onInferenceCompleted(uint64_t frameTsNs,
                                                  double inferenceMs,
                                                  TimePoint now) {
  (void)now;
  lastInferredTsNs_ = frameTsNs;
  framesSinceInference_ = 0;
  if (inferenceMs > 0.0) {
    emaMs_ = emaMs_ < 0.0 ? inferenceMs
                          : config_.emaWeight * inferenceMs +
                                (1.0 - config_.emaWeight) * emaMs_;
  }
}

void FusedCadenceController::reset() {
  emaMs_ = -1.0;
  lastInferredTsNs_ = 0u;
  framesSinceInference_ = 0;
}

void downsampleLumaThumb(const uint8_t *rgba, uint32_t width, uint32_t height,
                         LumaThumb &out, uint32_t thumbWidth,
                         uint32_t thumbHeight) {
  if (rgba == nullptr || width == 0u || height == 0u || thumbWidth == 0u ||
      thumbHeight == 0u) {
    out.width = 0u;
    out.height = 0u;
    out.luma.clear();
    return;
  }
  out.width = thumbWidth;
  out.height = thumbHeight;
  out.luma.resize(static_cast<size_t>(thumbWidth) * thumbHeight);
  for (uint32_t y = 0; y < thumbHeight; ++y) {
    const uint32_t sy = static_cast<uint32_t>(
        (static_cast<uint64_t>(y) * height) / thumbHeight);
    for (uint32_t x = 0; x < thumbWidth; ++x) {
      const uint32_t sx = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * width) / thumbWidth);
      const size_t srcOffset =
          (static_cast<size_t>(sy) * width + sx) * 4u;
      // Integer Rec.601 luma approximation: (54R + 183G + 19B) / 256.
      const uint32_t luma = (54u * rgba[srcOffset + 0u] +
                             183u * rgba[srcOffset + 1u] +
                             19u * rgba[srcOffset + 2u]) >>
                            8u;
      out.luma[static_cast<size_t>(y) * thumbWidth + x] =
          static_cast<uint8_t>(std::min(luma, 255u));
    }
  }
}

double meanAbsLumaDiff(const LumaThumb &a, const LumaThumb &b) {
  if (!a.valid() || !b.valid() || a.width != b.width || a.height != b.height) {
    return 0.0;
  }
  uint64_t sum = 0u;
  const size_t count = a.luma.size();
  for (size_t i = 0; i < count; ++i) {
    const int diff = static_cast<int>(a.luma[i]) - static_cast<int>(b.luma[i]);
    sum += static_cast<uint64_t>(diff < 0 ? -diff : diff);
  }
  return count > 0u ? static_cast<double>(sum) / static_cast<double>(count)
                    : 0.0;
}

}  // namespace broadify::meeting
