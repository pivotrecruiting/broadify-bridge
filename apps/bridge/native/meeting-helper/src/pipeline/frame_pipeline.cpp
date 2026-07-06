#include "pipeline/frame_pipeline.h"

#include "compose/compositor.h"
#include "framebus_reader.h"
#include "framebus_writer.h"
#include "keyer/keyer_chain.h"
#include "util/json_utils.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace broadify::meeting {
namespace {

constexpr uint32_t kSlotCount = 3;
constexpr uint32_t kMaxAlphaDilateRadiusPx = 8;
constexpr uint32_t kMaxAlphaFeatherRadiusPx = 3;
constexpr uint32_t kTemporalProtectionRadiusPx = 10;
constexpr uint8_t kTemporalProtectionAlphaThreshold = 32;
constexpr uint64_t kTemporalAlphaMaxAgeNs = 250000000u;
constexpr double kStaleMaskAgeMs = 140.0;
constexpr float kSmoothstepLow = 0.12f;
constexpr float kSmoothstepHigh = 0.88f;
constexpr float kQuietPreviousWeight = 0.85f;
constexpr float kMotionPreviousWeight = 0.35f;
constexpr float kStalePreviousWeight = 0.12f;
constexpr uint8_t kEdgeStabilizationAlphaLow = 24u;
constexpr uint8_t kEdgeStabilizationAlphaHigh = 220u;
constexpr float kEdgeStabilizationMaxMotion = 0.55f;
constexpr double kEdgeStabilizationFreshAgeMs = 40.0;
constexpr double kEdgeStabilizationFadeOutAgeMs = 75.0;
constexpr float kEdgeStabilizationMinAgeFactor = 0.12f;
constexpr const char *kMeetingBackGraphicsFrameBusName = "bfy-meet-gfx-back";
constexpr const char *kMeetingFrontGraphicsFrameBusName = "bfy-meet-gfx-front";
constexpr double kMetricsWindowMs = 1000.0;
constexpr size_t kMaskAgeWindowSize = 30u;
// Joint bilateral upsampling of coarse segmentation masks: only masks below
// this width get refined (Vision "fast" delivers 256px; "balanced" 512px
// masks are already fine and would double the refinement cost).
constexpr uint32_t kMaskRefineMaxSourceWidthPx = 400u;
constexpr int kMaskRefineRadiusPx = 2;
constexpr float kMaskRefineSpatialSigmaPx = 1.0f;
constexpr float kMaskRefineRangeSigmaLuma = 14.0f;
constexpr auto kIdleSleep = std::chrono::milliseconds(1000);
constexpr auto kStaticPollInterval = std::chrono::milliseconds(100);
constexpr auto kStaticHeartbeatInterval = std::chrono::milliseconds(1000);
// Duty-cycle guard: only when one keyer pass clearly exceeds a camera frame
// interval (1.5x, i.e. the machine sustains at most ~20fps anyway) insert a
// cooldown of this fraction of the pass duration, so weak machines keep ~20%
// idle headroom instead of running at full load. Borderline machines that
// almost keep camera rate must not be penalized.
constexpr double kKeyerCooldownTriggerFactor = 1.5;
constexpr double kKeyerCooldownFraction = 0.25;
constexpr double kKeyerMaxCooldownMs = 50.0;

struct MaskSample {
  size_t lower = 0u;
  size_t upper = 0u;
  uint32_t upperWeight = 0u;
};

struct PairedKeyerFrame {
  VideoFrame frame;
  AlphaMask mask;
  uint64_t publishedAtNs = 0u;
};

struct KeyerRuntimeStats {
  double keyerFps = -1.0;
  double droppedFramesPerSec = -1.0;
  uint64_t droppedFramesTotal = 0;
  uint64_t skippedFramesTotal = 0;
};

struct PipelineRuntimeState {
  bool cameraRunning = false;
  bool keyerEnabled = false;
  bool framebusRunning = false;
  int previewClients = 0;
  int vcamClients = 0;
  bool programDirty = false;
  bool graphicsDirty = false;
  uint64_t programRevision = 0;
  std::string mode = "idle";
};

bool hasActiveOutputConsumer(const PipelineRuntimeState &runtime) {
  return runtime.framebusRunning || runtime.previewClients > 0 || runtime.vcamClients > 0;
}

bool isGraphicsOutputActive(const CompositorSnapshot &snapshot) {
  return snapshot.graphics.enabled ||
      !snapshot.graphics.graphicId.empty() ||
      !snapshot.graphics.templateName.empty() ||
      !snapshot.graphics.source.empty();
}

std::string determinePipelineMode(const PipelineRuntimeState &runtime,
                                  const CompositorSnapshot &snapshot) {
  if (runtime.cameraRunning) {
    return runtime.keyerEnabled ? "keyer_live" : "live";
  }
  if (isGraphicsOutputActive(snapshot)) {
    return "live";
  }
  if (hasActiveOutputConsumer(runtime)) {
    return "static_output";
  }
  return "idle";
}

class RateMeter {
 public:
  void tick(const std::chrono::steady_clock::time_point now) {
    if (windowStart_ == std::chrono::steady_clock::time_point{}) {
      windowStart_ = now;
    }
    ++currentCount_;
    update(now);
  }

  double value(const std::chrono::steady_clock::time_point now) {
    update(now);
    return currentValue_;
  }

 private:
  void update(const std::chrono::steady_clock::time_point now) {
    if (windowStart_ == std::chrono::steady_clock::time_point{}) {
      return;
    }
    const double elapsedMs = std::chrono::duration<double, std::milli>(now - windowStart_).count();
    if (elapsedMs < kMetricsWindowMs) {
      return;
    }
    currentValue_ = static_cast<double>(currentCount_) * 1000.0 / std::max(1.0, elapsedMs);
    currentCount_ = 0u;
    windowStart_ = now;
  }

  std::chrono::steady_clock::time_point windowStart_{};
  uint64_t currentCount_ = 0u;
  double currentValue_ = -1.0;
};

class RollingAverage {
 public:
  void add(double value) {
    if (value < 0.0) {
      return;
    }
    samples_.push_back(value);
    sum_ += value;
    while (samples_.size() > kMaskAgeWindowSize) {
      sum_ -= samples_.front();
      samples_.pop_front();
    }
  }

  double value() const {
    if (samples_.empty()) {
      return -1.0;
    }
    return sum_ / static_cast<double>(samples_.size());
  }

  void clear() {
    samples_.clear();
    sum_ = 0.0;
  }

 private:
  std::deque<double> samples_;
  double sum_ = 0.0;
};

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

float clamp01(float value) {
  return std::clamp(value, 0.0f, 1.0f);
}

float lerp(float start, float end, float amount) {
  return start + (end - start) * amount;
}

float smoothstep(float edge0, float edge1, float value) {
  const float t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3.0f - 2.0f * t);
}

const std::array<uint8_t, 256> &smoothstepAlphaLut() {
  static const std::array<uint8_t, 256> lut = [] {
    std::array<uint8_t, 256> table{};
    for (size_t index = 0; index < table.size(); ++index) {
      const float normalizedAlpha = static_cast<float>(index) / 255.0f;
      table[index] =
          static_cast<uint8_t>(std::round(smoothstep(kSmoothstepLow, kSmoothstepHigh, normalizedAlpha) * 255.0f));
    }
    return table;
  }();
  return lut;
}

void remapAlphaSmoothstep(AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return;
  }

  const std::array<uint8_t, 256> &lut = smoothstepAlphaLut();
  for (uint8_t &alpha : mask.alpha) {
    alpha = lut[alpha];
  }
}

constexpr int kMaskRefineTapCount = 2 * kMaskRefineRadiusPx + 1;

const std::array<uint16_t, 256> &maskRefineRangeLut() {
  static const std::array<uint16_t, 256> lut = [] {
    std::array<uint16_t, 256> table{};
    for (size_t diff = 0; diff < table.size(); ++diff) {
      const float weight = std::exp(
          -static_cast<float>(diff * diff) /
          (2.0f * kMaskRefineRangeSigmaLuma * kMaskRefineRangeSigmaLuma));
      table[diff] = static_cast<uint16_t>(std::round(weight * 64.0f));
    }
    return table;
  }();
  return lut;
}

// Spatial weights per output-pixel parity: with 2x upsampling, even/odd output
// pixels sit a quarter source pixel left/right (up/down) of their base tap.
const std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> &maskRefineSpatialLut() {
  static const std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> lut = [] {
    std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> table{};
    for (int parity = 0; parity < 2; ++parity) {
      const float offset = parity == 0 ? -0.25f : 0.25f;
      for (int tap = 0; tap < kMaskRefineTapCount; ++tap) {
        const float distance = static_cast<float>(tap - kMaskRefineRadiusPx) - offset;
        const float weight = std::exp(
            -(distance * distance) /
            (2.0f * kMaskRefineSpatialSigmaPx * kMaskRefineSpatialSigmaPx));
        table[parity][tap] = static_cast<uint16_t>(std::round(weight * 64.0f));
      }
    }
    return table;
  }();
  return lut;
}

// Edge-guided smoothing at mask resolution for mid-size masks (Vision
// "balanced"): same joint-bilateral kernel as the 2x upsampling path, but
// without scaling - the mask snaps to real image contours and flickers less.
void smoothAlphaMaskEdgesGuided(AlphaMask &mask, const VideoFrame &frame) {
  const uint32_t width = mask.width;
  const uint32_t height = mask.height;
  std::vector<uint8_t> luma(static_cast<size_t>(width) * height);
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t frameY = std::min<uint32_t>(
        frame.height - 1u,
        static_cast<uint32_t>(((2ull * y + 1ull) * frame.height) / (2ull * height)));
    const size_t frameRowOffset = static_cast<size_t>(frameY) * frame.width;
    const size_t lumaRowOffset = static_cast<size_t>(y) * width;
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t frameX = std::min<uint32_t>(
          frame.width - 1u,
          static_cast<uint32_t>(((2ull * x + 1ull) * frame.width) / (2ull * width)));
      const size_t pixelOffset = (frameRowOffset + frameX) * 4u;
      luma[lumaRowOffset + x] = static_cast<uint8_t>(
          (77u * frame.rgba[pixelOffset] +
           150u * frame.rgba[pixelOffset + 1u] +
           29u * frame.rgba[pixelOffset + 2u]) >> 8u);
    }
  }

  static const uint16_t kCenteredSpatial[kMaskRefineTapCount] = {9, 39, 64, 39, 9};
  const std::array<uint16_t, 256> &rangeLut = maskRefineRangeLut();
  std::vector<uint8_t> smoothed(mask.alpha.size());
  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t *guideRow = luma.data() + static_cast<size_t>(y) * width;
    uint8_t *outputRow = smoothed.data() + static_cast<size_t>(y) * width;
    for (uint32_t x = 0; x < width; ++x) {
      const uint8_t guide = guideRow[x];
      uint32_t weightedAlpha = 0u;
      uint32_t weightSum = 0u;
      for (int tapY = 0; tapY < kMaskRefineTapCount; ++tapY) {
        const int sampleY = std::clamp(static_cast<int>(y) + tapY - kMaskRefineRadiusPx, 0, static_cast<int>(height) - 1);
        const size_t rowOffset = static_cast<size_t>(sampleY) * width;
        const uint32_t wy = kCenteredSpatial[tapY];
        for (int tapX = 0; tapX < kMaskRefineTapCount; ++tapX) {
          const int sampleX = std::clamp(static_cast<int>(x) + tapX - kMaskRefineRadiusPx, 0, static_cast<int>(width) - 1);
          const size_t sampleOffset = rowOffset + static_cast<size_t>(sampleX);
          const uint32_t lumaDiff = static_cast<uint32_t>(
              std::abs(static_cast<int>(luma[sampleOffset]) - static_cast<int>(guide)));
          const uint32_t weight = wy * kCenteredSpatial[tapX] * rangeLut[lumaDiff];
          weightedAlpha += weight * mask.alpha[sampleOffset];
          weightSum += weight;
        }
      }
      outputRow[x] = weightSum > 0u
          ? static_cast<uint8_t>((weightedAlpha + weightSum / 2u) / weightSum)
          : mask.alpha[static_cast<size_t>(y) * width + x];
    }
  }
  mask.alpha = std::move(smoothed);
}

// Joint bilateral 2x upsampling: coarse masks (e.g. Vision "fast", 256x192)
// are refined along the luminance edges of the camera frame before
// postprocessing, so cheap masks produce smooth, image-aligned edges instead
// of the blocky gradients a plain bilinear upscale would give.
void refineAlphaMaskEdges(AlphaMask &mask, const VideoFrame &frame) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u ||
      frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return;
  }
  if (mask.width >= kMaskRefineMaxSourceWidthPx) {
    // Mid-size (balanced) masks: edge-guided smoothing without upscaling.
    if (mask.width < 640u) {
      smoothAlphaMaskEdgesGuided(mask, frame);
    }
    return;
  }

  const uint32_t refinedWidth = mask.width * 2u;
  const uint32_t refinedHeight = mask.height * 2u;

  // Guide luma at refined resolution; the mask spans the full frame, so
  // sample the camera frame at matching normalized positions.
  std::vector<uint8_t> lumaHigh(static_cast<size_t>(refinedWidth) * refinedHeight);
  for (uint32_t y = 0; y < refinedHeight; ++y) {
    const uint32_t frameY = std::min<uint32_t>(
        frame.height - 1u,
        static_cast<uint32_t>(((2ull * y + 1ull) * frame.height) / (2ull * refinedHeight)));
    const size_t frameRowOffset = static_cast<size_t>(frameY) * frame.width;
    const size_t lumaRowOffset = static_cast<size_t>(y) * refinedWidth;
    for (uint32_t x = 0; x < refinedWidth; ++x) {
      const uint32_t frameX = std::min<uint32_t>(
          frame.width - 1u,
          static_cast<uint32_t>(((2ull * x + 1ull) * frame.width) / (2ull * refinedWidth)));
      const size_t pixelOffset = (frameRowOffset + frameX) * 4u;
      lumaHigh[lumaRowOffset + x] = static_cast<uint8_t>(
          (77u * frame.rgba[pixelOffset] +
           150u * frame.rgba[pixelOffset + 1u] +
           29u * frame.rgba[pixelOffset + 2u]) >> 8u);
    }
  }

  // Guide luma at mask resolution (2x2 box of the refined guide).
  std::vector<uint8_t> lumaLow(static_cast<size_t>(mask.width) * mask.height);
  for (uint32_t y = 0; y < mask.height; ++y) {
    const size_t rowTop = static_cast<size_t>(y) * 2u * refinedWidth;
    const size_t rowBottom = rowTop + refinedWidth;
    for (uint32_t x = 0; x < mask.width; ++x) {
      const size_t left = static_cast<size_t>(x) * 2u;
      const uint32_t sum =
          static_cast<uint32_t>(lumaHigh[rowTop + left]) + lumaHigh[rowTop + left + 1u] +
          lumaHigh[rowBottom + left] + lumaHigh[rowBottom + left + 1u];
      lumaLow[static_cast<size_t>(y) * mask.width + x] = static_cast<uint8_t>(sum / 4u);
    }
  }

  const std::array<uint16_t, 256> &rangeLut = maskRefineRangeLut();
  const auto &spatialLut = maskRefineSpatialLut();
  std::vector<uint8_t> refinedAlpha(lumaHigh.size());
  for (uint32_t oy = 0; oy < refinedHeight; ++oy) {
    const int baseY = static_cast<int>(oy >> 1u);
    const std::array<uint16_t, kMaskRefineTapCount> &spatialY = spatialLut[oy & 1u];
    const uint8_t *guideRow = lumaHigh.data() + static_cast<size_t>(oy) * refinedWidth;
    uint8_t *outputRow = refinedAlpha.data() + static_cast<size_t>(oy) * refinedWidth;
    for (uint32_t ox = 0; ox < refinedWidth; ++ox) {
      const int baseX = static_cast<int>(ox >> 1u);
      const std::array<uint16_t, kMaskRefineTapCount> &spatialX = spatialLut[ox & 1u];
      const uint8_t guideLuma = guideRow[ox];
      uint32_t weightedAlpha = 0u;
      uint32_t weightSum = 0u;
      for (int tapY = 0; tapY < kMaskRefineTapCount; ++tapY) {
        const int sampleY = std::clamp(baseY + tapY - kMaskRefineRadiusPx, 0, static_cast<int>(mask.height) - 1);
        const size_t sampleRowOffset = static_cast<size_t>(sampleY) * mask.width;
        const uint32_t spatialWeightY = spatialY[tapY];
        for (int tapX = 0; tapX < kMaskRefineTapCount; ++tapX) {
          const int sampleX = std::clamp(baseX + tapX - kMaskRefineRadiusPx, 0, static_cast<int>(mask.width) - 1);
          const size_t sampleOffset = sampleRowOffset + static_cast<size_t>(sampleX);
          const uint32_t lumaDiff = static_cast<uint32_t>(
              std::abs(static_cast<int>(lumaLow[sampleOffset]) - static_cast<int>(guideLuma)));
          const uint32_t weight = spatialWeightY * spatialX[tapX] * rangeLut[lumaDiff];
          weightedAlpha += weight * mask.alpha[sampleOffset];
          weightSum += weight;
        }
      }
      outputRow[ox] = weightSum > 0u
          ? static_cast<uint8_t>((weightedAlpha + weightSum / 2u) / weightSum)
          : mask.alpha[static_cast<size_t>(baseY) * mask.width + static_cast<size_t>(baseX)];
    }
  }

  mask.width = refinedWidth;
  mask.height = refinedHeight;
  mask.alpha = std::move(refinedAlpha);
}

struct WedgeEntry {
  size_t index = 0u;
  uint8_t value = 0u;
};

// Sliding-window extremum (monotonic wedge): for every position the min or
// max over the clamped window [i - radius, i + radius] in amortized O(1) per
// pixel, independent of the radius. Results match a brute-force clamped
// window scan exactly.
void slidingExtremaLine(const uint8_t *source,
                        uint8_t *destination,
                        size_t count,
                        size_t stride,
                        size_t radius,
                        bool takeMax,
                        std::vector<WedgeEntry> &wedge) {
  if (count == 0u) {
    return;
  }

  wedge.clear();
  size_t head = 0u;
  size_t next = 0u;
  const auto push = [&](size_t index) {
    const uint8_t candidate = source[index * stride];
    while (wedge.size() > head &&
           (takeMax ? wedge.back().value <= candidate : wedge.back().value >= candidate)) {
      wedge.pop_back();
    }
    wedge.push_back(WedgeEntry{index, candidate});
  };

  for (size_t index = 0; index < count; ++index) {
    const size_t upper = std::min(count - 1u, index + radius);
    while (next <= upper) {
      push(next);
      ++next;
    }
    const size_t lower = index > radius ? index - radius : 0u;
    while (wedge[head].index < lower) {
      ++head;
    }
    destination[index * stride] = wedge[head].value;
  }
}

void slidingExtrema2d(const std::vector<uint8_t> &source,
                      std::vector<uint8_t> &destination,
                      uint32_t width,
                      uint32_t height,
                      uint32_t radius,
                      bool takeMax) {
  std::vector<uint8_t> horizontal(source.size());
  std::vector<WedgeEntry> wedge;
  wedge.reserve(static_cast<size_t>(radius) * 2u + 2u);
  for (uint32_t y = 0; y < height; ++y) {
    const size_t rowOffset = static_cast<size_t>(y) * width;
    slidingExtremaLine(source.data() + rowOffset, horizontal.data() + rowOffset, width, 1u, radius, takeMax, wedge);
  }
  destination.resize(source.size());
  for (uint32_t x = 0; x < width; ++x) {
    slidingExtremaLine(horizontal.data() + x, destination.data() + x, height, width, radius, takeMax, wedge);
  }
}

void dilateAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  std::vector<uint8_t> dilatedAlpha;
  slidingExtrema2d(mask.alpha, dilatedAlpha, mask.width, mask.height, radius, true);
  mask.alpha = std::move(dilatedAlpha);
}

std::vector<uint8_t> erodedAlphaForRadius(const AlphaMask &mask, uint32_t radius) {
  std::vector<uint8_t> erodedAlpha;
  slidingExtrema2d(mask.alpha, erodedAlpha, mask.width, mask.height, radius, false);
  return erodedAlpha;
}

void erodeAlpha(AlphaMask &mask, double radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius <= 0.0) {
    return;
  }

  const double clampedRadius = std::clamp(radius, 0.0, 3.0);
  const uint32_t lowerRadius = static_cast<uint32_t>(std::floor(clampedRadius));
  const uint32_t upperRadius = static_cast<uint32_t>(std::ceil(clampedRadius));
  const double upperWeight = clampedRadius - static_cast<double>(lowerRadius);

  if (upperRadius == 0u) {
    return;
  }

  const std::vector<uint8_t> originalAlpha = mask.alpha;
  std::vector<uint8_t> lowerAlpha = lowerRadius == 0u ? originalAlpha : erodedAlphaForRadius(mask, lowerRadius);
  if (upperWeight <= 0.0 || lowerRadius == upperRadius) {
    mask.alpha = std::move(lowerAlpha);
    return;
  }

  const std::vector<uint8_t> upperAlpha = erodedAlphaForRadius(mask, upperRadius);
  const double lowerWeight = 1.0 - upperWeight;
  for (size_t index = 0; index < mask.alpha.size(); ++index) {
    const double blendedAlpha =
        static_cast<double>(lowerAlpha[index]) * lowerWeight + static_cast<double>(upperAlpha[index]) * upperWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0, 255.0)));
  }
}

// Running-sum box average over the clamped window [i - radius, i + radius];
// same integer arithmetic as a brute-force window scan, but O(1) per pixel.
void slidingBoxAverageLine(const uint8_t *source,
                           uint8_t *destination,
                           size_t count,
                           size_t stride,
                           size_t radius) {
  if (count == 0u) {
    return;
  }

  uint32_t sumAlpha = 0u;
  uint32_t sampleCount = 0u;
  const size_t initialUpper = std::min(count - 1u, radius);
  for (size_t index = 0; index <= initialUpper; ++index) {
    sumAlpha += source[index * stride];
    ++sampleCount;
  }

  for (size_t index = 0; index < count; ++index) {
    destination[index * stride] = static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    const size_t incoming = index + radius + 1u;
    if (incoming < count) {
      sumAlpha += source[incoming * stride];
      ++sampleCount;
    }
    if (index >= radius) {
      sumAlpha -= source[(index - radius) * stride];
      --sampleCount;
    }
  }
}

void featherAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> featheredAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    const size_t rowOffset = static_cast<size_t>(y) * mask.width;
    slidingBoxAverageLine(mask.alpha.data() + rowOffset, horizontalAlpha.data() + rowOffset, mask.width, 1u, radius);
  }
  for (uint32_t x = 0; x < mask.width; ++x) {
    slidingBoxAverageLine(horizontalAlpha.data() + x, featheredAlpha.data() + x, mask.height, mask.width, radius);
  }

  mask.alpha = std::move(featheredAlpha);
}

std::vector<uint8_t> alphaProtectionMask(const AlphaMask &mask, uint32_t radius) {
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> sourceMask(pixelCount);
  for (size_t index = 0; index < pixelCount; ++index) {
    sourceMask[index] = mask.alpha[index] >= kTemporalProtectionAlphaThreshold ? 1u : 0u;
  }

  std::vector<uint8_t> protectionMask;
  slidingExtrema2d(sourceMask, protectionMask, mask.width, mask.height, radius, true);
  return protectionMask;
}

void blendAlphaTemporal(AlphaMask &mask, const AlphaMask &previousMask, double maskAgeMs) {
  if (mask.alpha.empty() ||
      previousMask.alpha.empty() ||
      mask.width == 0u ||
      mask.height == 0u ||
      mask.width != previousMask.width ||
      mask.height != previousMask.height ||
      mask.timestampNs <= previousMask.timestampNs ||
      mask.timestampNs - previousMask.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const std::vector<uint8_t> protectionMask = alphaProtectionMask(mask, kTemporalProtectionRadiusPx);
  const float maxPreviousWeight = maskAgeMs >= kStaleMaskAgeMs ? kStalePreviousWeight : kQuietPreviousWeight;
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const uint8_t currentAlpha = mask.alpha[index];
    const uint8_t previousAlpha = previousMask.alpha[index];
    if (protectionMask[index] == 0u) {
      continue;
    }
    const float motion = static_cast<float>(std::abs(static_cast<int>(currentAlpha) - static_cast<int>(previousAlpha))) / 255.0f;
    const float previousWeight = lerp(maxPreviousWeight, kMotionPreviousWeight, motion);
    const float currentWeight = 1.0f - previousWeight;
    const float blendedAlpha =
        static_cast<float>(currentAlpha) * currentWeight +
        static_cast<float>(previousAlpha) * previousWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0f, 255.0f)));
  }
}

void stabilizeAlphaEdges(AlphaMask &mask, const AlphaMask &previousMask, const KeyerSettings &settings, double maskAgeMs) {
  if (!settings.edgeStabilizationEnabled ||
      settings.edgeStabilizationStrength <= 0.0 ||
      mask.alpha.empty() ||
      previousMask.alpha.empty() ||
      mask.width == 0u ||
      mask.height == 0u ||
      mask.width != previousMask.width ||
      mask.height != previousMask.height ||
      mask.timestampNs <= previousMask.timestampNs ||
      mask.timestampNs - previousMask.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const std::array<uint8_t, 256> &lut = smoothstepAlphaLut();
  const float strength = static_cast<float>(std::clamp(settings.edgeStabilizationStrength, 0.0, 1.0));
  float ageFactor = 1.0f;
  if (maskAgeMs >= kEdgeStabilizationFadeOutAgeMs) {
    ageFactor = kEdgeStabilizationMinAgeFactor;
  } else if (maskAgeMs > kEdgeStabilizationFreshAgeMs) {
    const double fadeProgress =
        (maskAgeMs - kEdgeStabilizationFreshAgeMs) /
        (kEdgeStabilizationFadeOutAgeMs - kEdgeStabilizationFreshAgeMs);
    ageFactor = lerp(1.0f, kEdgeStabilizationMinAgeFactor, static_cast<float>(fadeProgress));
  }
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const uint8_t currentAlpha = mask.alpha[index];
    if (currentAlpha <= kEdgeStabilizationAlphaLow || currentAlpha >= kEdgeStabilizationAlphaHigh) {
      continue;
    }

    const uint8_t previousAlpha = lut[previousMask.alpha[index]];
    const float motion = static_cast<float>(std::abs(static_cast<int>(currentAlpha) - static_cast<int>(previousAlpha))) / 255.0f;
    if (motion >= kEdgeStabilizationMaxMotion) {
      continue;
    }

    const float normalizedAlpha = static_cast<float>(currentAlpha) / 255.0f;
    const float edgeFactor = 1.0f - std::abs((normalizedAlpha - 0.5f) * 2.0f);
    const float motionFactor = 1.0f - (motion / kEdgeStabilizationMaxMotion);
    const float previousWeight = std::clamp(strength * edgeFactor * motionFactor * ageFactor, 0.0f, 0.65f);
    const float currentWeight = 1.0f - previousWeight;
    const float blendedAlpha =
        static_cast<float>(currentAlpha) * currentWeight + static_cast<float>(previousAlpha) * previousWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0f, 255.0f)));
  }
}

uint32_t dynamicDilationRadius(const KeyerSettings &settings, double maskAgeMs) {
  uint32_t radius = std::min(settings.maskDilatePx, kMaxAlphaDilateRadiusPx);
  if (radius == 0u || !settings.dynamicDilation || maskAgeMs < 0.0) {
    return radius;
  }
  if (maskAgeMs >= 200.0) {
    radius += 4u;
  } else if (maskAgeMs >= 132.0) {
    radius += 3u;
  } else if (maskAgeMs >= 66.0) {
    radius += 2u;
  }
  return std::min(radius, kMaxAlphaDilateRadiusPx);
}

void postprocessAlpha(AlphaMask &mask,
                      const AlphaMask &previousMask,
                      const KeyerSettings &settings,
                      double maskAgeMs,
                      KeyerMetrics &metrics) {
  const auto start = std::chrono::steady_clock::now();
  remapAlphaSmoothstep(mask);
  stabilizeAlphaEdges(mask, previousMask, settings, maskAgeMs);
  const auto dilateStart = std::chrono::steady_clock::now();
  erodeAlpha(mask, settings.maskErodePx);
  dilateAlpha(mask, dynamicDilationRadius(settings, maskAgeMs));
  const auto dilateEnd = std::chrono::steady_clock::now();
  featherAlpha(mask, std::min(settings.maskFeatherPx, kMaxAlphaFeatherRadiusPx));
  const auto end = std::chrono::steady_clock::now();
  metrics.maskDilateMs = elapsedMs(dilateStart, dilateEnd);
  metrics.maskPostprocessMs = elapsedMs(start, end);
}

uint8_t sampleMaskBilinear(const AlphaMask &mask,
                           const std::vector<MaskSample> &xSamples,
                           const std::vector<MaskSample> &ySamples,
                           uint32_t x,
                           uint32_t y) {
  const MaskSample &sampleY = ySamples[y];
  const uint32_t yWeight = sampleY.upperWeight;
  const uint32_t inverseYWeight = 256u - yWeight;
  const uint8_t *row0 = mask.alpha.data() + sampleY.lower * mask.width;
  const uint8_t *row1 = mask.alpha.data() + sampleY.upper * mask.width;
  const MaskSample &sampleX = xSamples[x];
  const uint32_t xWeight = sampleX.upperWeight;
  const uint32_t inverseXWeight = 256u - xWeight;
  const uint32_t top =
      static_cast<uint32_t>(row0[sampleX.lower]) * inverseXWeight +
      static_cast<uint32_t>(row0[sampleX.upper]) * xWeight;
  const uint32_t bottom =
      static_cast<uint32_t>(row1[sampleX.lower]) * inverseXWeight +
      static_cast<uint32_t>(row1[sampleX.upper]) * xWeight;
  const uint32_t alpha = (top * inverseYWeight + bottom * yWeight + 32768u) >> 16u;
  return static_cast<uint8_t>(std::min(alpha, 255u));
}

void buildMaskSamples(uint32_t frameWidth,
                      uint32_t frameHeight,
                      const AlphaMask &mask,
                      std::vector<MaskSample> &xSamples,
                      std::vector<MaskSample> &ySamples) {
  xSamples.assign(frameWidth, MaskSample{});
  ySamples.assign(frameHeight, MaskSample{});
  for (uint32_t x = 0; x < frameWidth; ++x) {
    const double sourceX = frameWidth > 1u
        ? (static_cast<double>(x) * static_cast<double>(mask.width - 1u)) / static_cast<double>(frameWidth - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceX));
    xSamples[x].lower = lower;
    xSamples[x].upper = std::min<size_t>(mask.width - 1u, lower + 1u);
    xSamples[x].upperWeight = static_cast<uint32_t>(std::round((sourceX - static_cast<double>(lower)) * 256.0));
  }
  for (uint32_t y = 0; y < frameHeight; ++y) {
    const double sourceY = frameHeight > 1u
        ? (static_cast<double>(y) * static_cast<double>(mask.height - 1u)) / static_cast<double>(frameHeight - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceY));
    ySamples[y].lower = lower;
    ySamples[y].upper = std::min<size_t>(mask.height - 1u, lower + 1u);
    ySamples[y].upperWeight = static_cast<uint32_t>(std::round((sourceY - static_cast<double>(lower)) * 256.0));
  }
}


uint8_t normalizeKeyedLayerAlpha(uint8_t alpha) {
  constexpr uint8_t kTransparentCutoff = 18u;
  constexpr uint8_t kOpaqueCutoff = 242u;

  if (alpha <= kTransparentCutoff) {
    return 0u;
  }
  if (alpha >= kOpaqueCutoff) {
    return 255u;
  }

  const float normalized = static_cast<float>(alpha - kTransparentCutoff) /
      static_cast<float>(kOpaqueCutoff - kTransparentCutoff);
  return static_cast<uint8_t>(std::round(smoothstep(0.0f, 1.0f, normalized) * 255.0f));
}

// Applies the alpha mask onto the frame in place. Runs on the keyer worker
// thread once per published mask, so the program loop composites pre-keyed
// frames without a full-resolution alpha pass (and frame copy) per program
// frame.
void applyAlphaMaskToFrame(VideoFrame &frame, const AlphaMask &mask) {
  if (frame.rgba.empty() ||
      mask.alpha.empty() ||
      frame.width == 0u ||
      frame.height == 0u ||
      mask.width == 0u ||
      mask.height == 0u) {
    return;
  }

  std::vector<MaskSample> xSamples(frame.width);
  std::vector<MaskSample> ySamples(frame.height);
  buildMaskSamples(frame.width, frame.height, mask, xSamples, ySamples);

  for (uint32_t y = 0; y < frame.height; ++y) {
    for (uint32_t x = 0; x < frame.width; ++x) {
      const size_t frameOffset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      const uint8_t sampledAlpha = sampleMaskBilinear(mask, xSamples, ySamples, x, y);
      const uint8_t normalizedAlpha = normalizeKeyedLayerAlpha(sampledAlpha);
      frame.rgba[frameOffset + 3u] = normalizedAlpha;
      if (normalizedAlpha == 0u) {
        frame.rgba[frameOffset + 0u] = 0u;
        frame.rgba[frameOffset + 1u] = 0u;
        frame.rgba[frameOffset + 2u] = 0u;
      }
    }
  }
}

class AsyncKeyerWorker {
 public:
  AsyncKeyerWorker(const Options &options, MeetingState &state, std::atomic<bool> &running)
      : keyerChain_(options),
        state_(state),
        running_(running),
        frameIntervalMs_(1000.0 / static_cast<double>(options.fps == 0u ? 30u : options.fps)),
        thread_(&AsyncKeyerWorker::run, this) {}

  ~AsyncKeyerWorker() {
    stop();
  }

  // Adaptive pacing: every new camera frame is offered to the worker; while
  // the worker is busy the pending slot is replaced (counted as dropped) so
  // inference always runs back-to-back on the freshest frame. The effective
  // keyer rate is min(camera fps, 1 / inference time) without a fixed cap.
  void submit(const VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (hasPendingFrame_) {
      ++droppedFrames_;
    }
    pendingFrame_ = frame;
    pendingGeneration_ = generation_;
    hasPendingFrame_ = true;
    cv_.notify_one();
  }

  // Returns the latest published pair without copying frame data; callers
  // share ownership of the immutable pair.
  std::shared_ptr<const PairedKeyerFrame> copyLatest() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return latestPair_;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++generation_;
    hasPendingFrame_ = false;
    latestPair_.reset();
    droppedFrames_ = 0;
    skippedFrames_ = 0;
    keyerRate_ = RateMeter{};
    lastDropRateSample_ = std::chrono::steady_clock::now();
    lastDropRateTotal_ = 0u;
    droppedFramesPerSec_ = -1.0;
  }

  uint64_t droppedFrames() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedFrames_;
  }

  KeyerRuntimeStats stats() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = std::chrono::steady_clock::now();
    updateDropRateLocked(now);
    return KeyerRuntimeStats{keyerRate_.value(now), droppedFramesPerSec_, droppedFrames_, skippedFrames_};
  }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
      hasPendingFrame_ = false;
    }
    cv_.notify_one();
    if (thread_.joinable()) {
      thread_.join();
    }
  }

 private:
  void run() {
    while (running_.load()) {
      VideoFrame frame;
      uint64_t generation = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [&]() {
          return stopping_ || !running_.load() || hasPendingFrame_;
        });
        if (stopping_ || !running_.load()) {
          return;
        }
        frame = std::move(pendingFrame_);
        generation = pendingGeneration_;
        hasPendingFrame_ = false;
      }

      const uint64_t keyerStartNs = nowNs();
      KeyerResult keyed = keyerChain_.process(frame, state_);
      const auto refineStart = std::chrono::steady_clock::now();
      refineAlphaMaskEdges(keyed.mask, frame);
      const double refineMs = elapsedMs(refineStart, std::chrono::steady_clock::now());
      AlphaMask previousMask;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (latestPair_ != nullptr) {
          previousMask = latestPair_->mask;
        }
      }
      KeyerSettings settings;
      double maskAgeMs = -1.0;
      {
        std::lock_guard<std::mutex> stateLock(state_.mutex);
        settings.qualityMode = state_.qualityMode;
        settings.maskErodePx = state_.maskErodePx;
        settings.maskDilatePx = state_.maskDilatePx;
        settings.maskFeatherPx = state_.maskFeatherPx;
        settings.dynamicDilation = state_.dynamicDilation;
        settings.temporalBlendEnabled = state_.temporalBlendEnabled;
        settings.edgeStabilizationEnabled = state_.edgeStabilizationEnabled;
        settings.edgeStabilizationStrength = state_.edgeStabilizationStrength;
        settings.degradation = state_.degradationSettings;
        maskAgeMs = state_.keyerMetrics.maskAgeMs;
      }
      if (settings.temporalBlendEnabled) {
        blendAlphaTemporal(keyed.mask, previousMask, maskAgeMs);
      }
      postprocessAlpha(keyed.mask, previousMask, settings, maskAgeMs, keyed.status.metrics);
      keyed.status.metrics.maskPostprocessMs += refineMs;
      keyed.status.metrics.maskWidth = keyed.mask.width;
      keyed.status.metrics.maskHeight = keyed.mask.height;
      bool shouldPublish = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        shouldPublish = !stopping_ && running_.load() && generation == generation_;
        if (shouldPublish) {
          const auto now = std::chrono::steady_clock::now();
          const uint64_t publishNs = nowNs();
          keyerRate_.tick(now);
          updateDropRateLocked(now);
          keyed.status.metrics.droppedFrames = droppedFrames_;
          keyed.status.metrics.skippedFrames = skippedFrames_;
          keyed.status.metrics.keyerFps = keyerRate_.value(now);
          keyed.status.metrics.droppedFramesPerSec = droppedFramesPerSec_;
          keyed.status.metrics.keyerInputAgeMs = frame.timestampNs > 0u && keyerStartNs >= frame.timestampNs
              ? static_cast<double>(keyerStartNs - frame.timestampNs) / 1000000.0
              : -1.0;
          keyed.status.metrics.keyerProcessingMs = publishNs >= keyerStartNs
              ? static_cast<double>(publishNs - keyerStartNs) / 1000000.0
              : -1.0;
          if (!keyed.mask.alpha.empty()) {
            auto pair = std::make_shared<PairedKeyerFrame>();
            pair->frame = std::move(frame);
            pair->mask = std::move(keyed.mask);
            pair->publishedAtNs = publishNs;
            latestPair_ = std::move(pair);
          } else {
            latestPair_.reset();
          }
        }
      }
      if (shouldPublish) {
        updateMeetingKeyerStatus(state_, keyed.status);
      }

      const double processingMs = static_cast<double>(nowNs() - keyerStartNs) / 1000000.0;
      if (running_.load() && processingMs > frameIntervalMs_ * kKeyerCooldownTriggerFactor) {
        const double cooldownMs = std::min(kKeyerMaxCooldownMs, processingMs * kKeyerCooldownFraction);
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(cooldownMs));
      }
    }
  }

  void updateDropRateLocked(const std::chrono::steady_clock::time_point now) {
    if (lastDropRateSample_ == std::chrono::steady_clock::time_point{}) {
      lastDropRateSample_ = now;
      lastDropRateTotal_ = droppedFrames_;
      return;
    }
    const double elapsedMs = std::chrono::duration<double, std::milli>(now - lastDropRateSample_).count();
    if (elapsedMs < kMetricsWindowMs) {
      return;
    }
    const uint64_t droppedDelta = droppedFrames_ >= lastDropRateTotal_ ? droppedFrames_ - lastDropRateTotal_ : 0u;
    droppedFramesPerSec_ = static_cast<double>(droppedDelta) * 1000.0 / std::max(1.0, elapsedMs);
    lastDropRateTotal_ = droppedFrames_;
    lastDropRateSample_ = now;
  }

  KeyerChain keyerChain_;
  MeetingState &state_;
  std::atomic<bool> &running_;
  const double frameIntervalMs_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
  VideoFrame pendingFrame_;
  std::shared_ptr<const PairedKeyerFrame> latestPair_;
  uint64_t generation_ = 0;
  uint64_t pendingGeneration_ = 0;
  uint64_t droppedFrames_ = 0;
  uint64_t skippedFrames_ = 0;
  RateMeter keyerRate_;
  std::chrono::steady_clock::time_point lastDropRateSample_{};
  uint64_t lastDropRateTotal_ = 0u;
  double droppedFramesPerSec_ = -1.0;
  bool hasPendingFrame_ = false;
  bool stopping_ = false;
};

class GraphicsFrameBusReader {
 public:
  explicit GraphicsFrameBusReader(std::string name) : name_(std::move(name)) {}

  ~GraphicsFrameBusReader() {
    close();
  }

  bool copyLatest(VideoFrame &frame, bool enabled) {
    if (!enabled) {
      close();
      hasLatestFrame_ = false;
      latestFrame_ = VideoFrame{};
      return false;
    }
    ensureOpen();
    if (reader_ == nullptr) {
      return hasLatestFrame_;
    }

    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fps = 0;
    if (framebus_reader_get_info(reader_, &width, &height, &fps) != 0 || width == 0u || height == 0u) {
      logReaderEvent("info_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }

    const size_t requiredSize = static_cast<size_t>(width) * height * 4u;
    if (scratch_.size() != requiredSize) {
      scratch_.assign(requiredSize, 0u);
    }
    const int result = framebus_reader_copy_latest_rgba(reader_, scratch_.data(), static_cast<size_t>(width) * 4u, &lastSeq_);
    if (result == -1) {
      logReaderEvent("copy_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }
    if (result == 1) {
      uint64_t nonTransparentPixels = 0;
      uint32_t maxAlpha = 0;
      const bool shouldSampleAlpha = lastSeq_ == 1u || lastSeq_ % 300u == 0u;
      if (shouldSampleAlpha) {
        for (size_t index = 3; index < scratch_.size(); index += 4u) {
          const uint32_t alpha = scratch_[index];
          if (alpha > 0u) {
            ++nonTransparentPixels;
            maxAlpha = std::max(maxAlpha, alpha);
          }
        }
      }
      latestFrame_.width = width;
      latestFrame_.height = height;
      latestFrame_.timestampNs = nowNs();
      latestFrame_.rgba = scratch_;
      hasLatestFrame_ = true;
      if (shouldSampleAlpha) {
        logReaderEvent("frame_read", width, height, fps, nonTransparentPixels, maxAlpha);
      }
    }

    if (hasLatestFrame_) {
      frame = latestFrame_;
    }
    return hasLatestFrame_;
  }

 private:
  void ensureOpen() {
    if (reader_ != nullptr) {
      return;
    }
    reader_ = framebus_reader_open(name_.c_str());
    lastSeq_ = 0;
    if (reader_ == nullptr) {
      logReaderEvent("open_failed", 0, 0, 0, 0, 0);
    } else {
      logReaderEvent("opened", 0, 0, 0, 0, 0);
    }
  }

  void close() {
    if (reader_ != nullptr) {
      framebus_reader_close(reader_);
      reader_ = nullptr;
      logReaderEvent("closed", 0, 0, 0, 0, 0);
    }
    lastSeq_ = 0;
  }

  void logReaderEvent(const char *event,
                      uint32_t width,
                      uint32_t height,
                      uint32_t fps,
                      uint64_t nonTransparentPixels,
                      uint32_t maxAlpha) {
    if (lastLoggedSeq_ == lastSeq_ && std::string(event) == lastLoggedEvent_) {
      return;
    }
    lastLoggedSeq_ = lastSeq_;
    lastLoggedEvent_ = event;
    std::cout << "{\"type\":\"meeting_graphics_framebus\",\"event\":\"" << event
              << "\",\"name\":\"" << name_
              << "\",\"seq\":" << lastSeq_
              << ",\"width\":" << width
              << ",\"height\":" << height
              << ",\"fps\":" << fps
              << ",\"non_transparent_pixels\":" << nonTransparentPixels
              << ",\"max_alpha\":" << maxAlpha
              << "}" << std::endl;
  }

  framebus_reader_t *reader_ = nullptr;
  uint64_t lastSeq_ = 0;
  uint64_t lastLoggedSeq_ = 0;
  std::string lastLoggedEvent_;
  std::string name_;
  bool hasLatestFrame_ = false;
  VideoFrame latestFrame_;
  std::vector<uint8_t> scratch_;
};

}  // namespace

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      std::atomic<bool> &running) {
  framebus_writer_t *writer = framebus_writer_open(
      options.framebusName.c_str(), options.width, options.height, options.fps, kSlotCount);
  if (writer == nullptr) {
    std::cout << "{\"type\":\"error\",\"code\":\"framebus_open_failed\",\"message\":\"Could not create FrameBus segment.\"}" << std::endl;
    return;
  }

  const uint32_t targetFps = options.fps == 0 ? 30u : options.fps;
  const auto frameInterval = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
      std::chrono::duration<double>(1.0 / static_cast<double>(targetFps)));
  auto nextFrameAt = std::chrono::steady_clock::now();
  uint64_t frameIndex = 0;
  std::vector<uint8_t> programFrame;
  VideoFrame latestCameraFrame;
  uint64_t lastCameraTimestampNs = 0u;
  uint64_t lastProgramRevision = 0u;
  uint64_t lastUsedKeyerPublishedNs = 0u;
  uint64_t lastBackGraphicsTimestampNs = 0u;
  uint64_t lastFrontGraphicsTimestampNs = 0u;
  auto lastStaticHeartbeatAt = std::chrono::steady_clock::time_point{};
  AsyncKeyerWorker keyerWorker(options, state, running);
  GraphicsFrameBusReader backGraphicsReader(kMeetingBackGraphicsFrameBusName);
  GraphicsFrameBusReader frontGraphicsReader(kMeetingFrontGraphicsFrameBusName);
  RateMeter programRate;
  RollingAverage maskAgeAverage;
  uint64_t previousProgramStartNs = 0u;
  while (running.load()) {
    PipelineRuntimeState runtime;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = camera.isRunning();
      state.activeCameraIndex = camera.activeCameraIndex();
      runtime.cameraRunning = state.cameraRunning;
      runtime.keyerEnabled = state.keyerEnabled;
      runtime.framebusRunning = state.framebusRunning;
      runtime.previewClients = state.previewClientCount;
      runtime.vcamClients = state.vcamClientCount;
      runtime.programDirty = state.programDirty;
      runtime.graphicsDirty = state.graphicsDirty;
      runtime.programRevision = state.programRevision;
    }

    const CompositorSnapshot snapshot = copyCompositorSnapshot(state);
    runtime.mode = determinePipelineMode(runtime, snapshot);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.pipelineMode = runtime.mode;
    }

    if (runtime.mode == "idle" && !runtime.programDirty && programFrame.empty()) {
      std::this_thread::sleep_for(kIdleSleep);
      nextFrameAt = std::chrono::steady_clock::now();
      continue;
    }

    const bool outputConsumerActive = hasActiveOutputConsumer(runtime);
    const bool previewConsumerActive = runtime.previewClients > 0 || runtime.vcamClients > 0;
    const auto programStart = std::chrono::steady_clock::now();
    const bool staticHeartbeatDue =
        lastStaticHeartbeatAt == std::chrono::steady_clock::time_point{} ||
        programStart - lastStaticHeartbeatAt >= kStaticHeartbeatInterval;
    bool shouldRenderProgram = runtime.programDirty || runtime.programRevision != lastProgramRevision || programFrame.empty();
    bool shouldPublishPreview = false;
    bool shouldWriteFramebus = false;

    {
      const uint64_t programStartNs = nowNs();
      const double programFrameIntervalMs = previousProgramStartNs > 0u && programStartNs >= previousProgramStartNs
          ? static_cast<double>(programStartNs - previousProgramStartNs) / 1000000.0
          : -1.0;
      previousProgramStartNs = programStartNs;
      const auto cameraCopyStart = std::chrono::steady_clock::now();
      // Copy straight into latestCameraFrame: the intermediate local frame
      // cost an extra full-frame copy (~3.7 MB) per camera frame.
      const bool hasNewCameraFrame = runtime.cameraRunning &&
          camera.copyLatestFrameIfNew(lastCameraTimestampNs, latestCameraFrame) &&
          !latestCameraFrame.rgba.empty();
      if (hasNewCameraFrame) {
        lastCameraTimestampNs = latestCameraFrame.timestampNs;
      } else if (!runtime.cameraRunning) {
        latestCameraFrame = VideoFrame{};
        lastCameraTimestampNs = 0u;
      }
      const bool hasCameraFrame = runtime.cameraRunning && !latestCameraFrame.rgba.empty();
      const auto cameraCopyEnd = std::chrono::steady_clock::now();
      const VideoFrame *frameForCompositor = nullptr;
      std::shared_ptr<const PairedKeyerFrame> selectedPair;
      KeyerSettings keyerSettings;
      bool keyerEnabled = false;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        keyerEnabled = state.keyerEnabled;
        keyerSettings.qualityMode = state.qualityMode;
        keyerSettings.maskErodePx = state.maskErodePx;
        keyerSettings.maskDilatePx = state.maskDilatePx;
        keyerSettings.maskFeatherPx = state.maskFeatherPx;
        keyerSettings.dynamicDilation = state.dynamicDilation;
        keyerSettings.temporalBlendEnabled = state.temporalBlendEnabled;
        keyerSettings.edgeStabilizationEnabled = state.edgeStabilizationEnabled;
        keyerSettings.edgeStabilizationStrength = state.edgeStabilizationStrength;
        keyerSettings.degradation = state.degradationSettings;
      }
      if (hasNewCameraFrame && keyerEnabled) {
        keyerWorker.submit(latestCameraFrame);
      }
      if (hasCameraFrame) {
        if (snapshot.keyerEnabled) {
          if (const std::shared_ptr<const PairedKeyerFrame> latestPair = keyerWorker.copyLatest()) {
            double maskAgeMs = 0.0;
            if (latestCameraFrame.timestampNs >= latestPair->frame.timestampNs) {
              maskAgeMs = static_cast<double>(latestCameraFrame.timestampNs - latestPair->frame.timestampNs) / 1000000.0;
            }
            maskAgeAverage.add(maskAgeMs);
            const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
            if (pairIsUsable) {
              selectedPair = latestPair;
              frameForCompositor = &selectedPair->frame;
            } else {
              frameForCompositor = &latestCameraFrame;
            }
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.keyerMetrics.maskAgeMs = maskAgeMs;
              state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
              state.keyerMetrics.keyerPublishToProgramMs = latestPair->publishedAtNs > 0u && programStartNs >= latestPair->publishedAtNs
                  ? static_cast<double>(programStartNs - latestPair->publishedAtNs) / 1000000.0
                  : -1.0;
              state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
              state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
              state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
              state.keyerMetrics.keyerFps = keyerStats.keyerFps;
              if (pairIsUsable) {
                state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
                state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
              } else {
                state.degradationStage = "passthrough";
                state.staleMaskActive = true;
              }
            }
          } else {
            frameForCompositor = &latestCameraFrame;
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.degradationStage = "passthrough";
              state.staleMaskActive = false;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
              state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
              state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
              state.keyerMetrics.keyerFps = keyerStats.keyerFps;
            }
          }
        } else {
          keyerWorker.clear();
          maskAgeAverage.clear();
          frameForCompositor = &latestCameraFrame;
          {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.degradationStage = "fresh";
            state.staleMaskActive = false;
            state.keyerMetrics.maskAgeAvgMs = -1.0;
          }
        }
      } else {
        keyerWorker.clear();
        maskAgeAverage.clear();
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.degradationStage = "passthrough";
          state.staleMaskActive = false;
          state.keyerMetrics.maskAgeAvgMs = -1.0;
        }
      }
      VideoFrame backGraphicsFrame;
      VideoFrame frontGraphicsFrame;
      const bool graphicsOutputActive = isGraphicsOutputActive(snapshot);
      const VideoFrame *backGraphicsFrameForCompositor =
          backGraphicsReader.copyLatest(backGraphicsFrame, graphicsOutputActive) ? &backGraphicsFrame : nullptr;
      const VideoFrame *frontGraphicsFrameForCompositor =
          frontGraphicsReader.copyLatest(frontGraphicsFrame, graphicsOutputActive) ? &frontGraphicsFrame : nullptr;
      const bool hasNewBackGraphicsFrame = backGraphicsFrameForCompositor != nullptr &&
          backGraphicsFrameForCompositor->timestampNs != 0u &&
          backGraphicsFrameForCompositor->timestampNs != lastBackGraphicsTimestampNs;
      const bool hasNewFrontGraphicsFrame = frontGraphicsFrameForCompositor != nullptr &&
          frontGraphicsFrameForCompositor->timestampNs != 0u &&
          frontGraphicsFrameForCompositor->timestampNs != lastFrontGraphicsTimestampNs;
      if (hasNewBackGraphicsFrame) {
        lastBackGraphicsTimestampNs = backGraphicsFrameForCompositor->timestampNs;
      }
      if (hasNewFrontGraphicsFrame) {
        lastFrontGraphicsTimestampNs = frontGraphicsFrameForCompositor->timestampNs;
      }
      if (hasCameraFrame && snapshot.keyerEnabled) {
        const std::shared_ptr<const PairedKeyerFrame> latestPair = keyerWorker.copyLatest();
        if (latestPair != nullptr &&
            (selectedPair == nullptr || latestPair->publishedAtNs > selectedPair->publishedAtNs)) {
          double maskAgeMs = 0.0;
          if (latestCameraFrame.timestampNs >= latestPair->frame.timestampNs) {
            maskAgeMs = static_cast<double>(latestCameraFrame.timestampNs - latestPair->frame.timestampNs) / 1000000.0;
          }
          maskAgeAverage.add(maskAgeMs);
          const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
          if (pairIsUsable) {
            selectedPair = latestPair;
            frameForCompositor = &selectedPair->frame;
          } else {
            frameForCompositor = &latestCameraFrame;
            selectedPair.reset();
          }
          const KeyerRuntimeStats keyerStats = keyerWorker.stats();
          const uint64_t programUseNs = nowNs();
          {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.keyerMetrics.maskAgeMs = maskAgeMs;
            state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
            state.keyerMetrics.keyerPublishToProgramMs = latestPair->publishedAtNs > 0u && programUseNs >= latestPair->publishedAtNs
                ? static_cast<double>(programUseNs - latestPair->publishedAtNs) / 1000000.0
                : -1.0;
            state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
            state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
            state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
            state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
            state.keyerMetrics.keyerFps = keyerStats.keyerFps;
            if (pairIsUsable) {
              state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
              state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
            } else {
              state.degradationStage = "passthrough";
              state.staleMaskActive = true;
            }
          }
        }
      }

      const bool hasNewUsableKeyerPair = selectedPair != nullptr && selectedPair->publishedAtNs > lastUsedKeyerPublishedNs;
      shouldRenderProgram = shouldRenderProgram ||
          hasNewCameraFrame ||
          hasNewBackGraphicsFrame ||
          hasNewFrontGraphicsFrame ||
          hasNewUsableKeyerPair ||
          ((runtime.mode == "live" || runtime.mode == "keyer_live") && graphicsOutputActive);
      if (runtime.mode == "idle" && !outputConsumerActive && !shouldRenderProgram) {
        std::this_thread::sleep_for(kIdleSleep);
        nextFrameAt = std::chrono::steady_clock::now();
        continue;
      }
      if (runtime.mode == "static_output" && !shouldRenderProgram && !staticHeartbeatDue) {
        std::this_thread::sleep_for(kStaticPollInterval);
        nextFrameAt = std::chrono::steady_clock::now();
        continue;
      }

      if (shouldRenderProgram) {
        renderProgramFrame(
            options,
            snapshot,
            frameForCompositor,
            selectedPair != nullptr ? &selectedPair->mask : nullptr,
            backGraphicsFrameForCompositor,
            frontGraphicsFrameForCompositor,
            frameIndex++,
            programFrame);
        if (selectedPair != nullptr) {
          lastUsedKeyerPublishedNs = selectedPair->publishedAtNs;
        }
        lastProgramRevision = runtime.programRevision;
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.programDirty = false;
          state.graphicsDirty = false;
          ++state.renderedFrames;
        }
      } else {
        std::lock_guard<std::mutex> lock(state.mutex);
        ++state.reusedFrames;
      }

      shouldWriteFramebus = runtime.framebusRunning && !programFrame.empty() &&
          (shouldRenderProgram || runtime.mode == "live" || runtime.mode == "keyer_live" || staticHeartbeatDue);
      if (shouldWriteFramebus) {
        framebus_writer_write_rgba(
            writer,
            programFrame.data(),
            programFrame.size(),
            hasCameraFrame ? latestCameraFrame.timestampNs : nowNs());
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          ++state.writtenFramebusFrames;
        }
        lastStaticHeartbeatAt = programStart;
      }

      shouldPublishPreview = previewConsumerActive && shouldRenderProgram && !programFrame.empty();
      if (shouldPublishPreview) {
        previewFrames.publish(options.width, options.height, programFrame.data(), programFrame.size());
        std::lock_guard<std::mutex> lock(state.mutex);
        ++state.publishedPreviewFrames;
      }

      const auto programEnd = std::chrono::steady_clock::now();
      programRate.tick(programEnd);
      nextFrameAt += frameInterval;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.keyerMetrics.programFrameMs = elapsedMs(programStart, programEnd);
        state.keyerMetrics.cameraCopyMs = elapsedMs(cameraCopyStart, cameraCopyEnd);
        state.keyerMetrics.programFps = programRate.value(programEnd);
        state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
      }
    }
    const auto now = std::chrono::steady_clock::now();
    if (nextFrameAt > now) {
      std::this_thread::sleep_until(nextFrameAt);
    } else {
      nextFrameAt = now;
    }
  }
  framebus_writer_close(writer);
}

}  // namespace broadify::meeting
