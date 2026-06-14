#include "pipeline/frame_pipeline.h"

#include "compose/compositor.h"
#include "framebus_reader.h"
#include "framebus_writer.h"
#include "keyer/keyer_chain.h"
#include "util/json_utils.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <iostream>
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
constexpr const char *kMeetingGraphicsFrameBusName = "bfy-meet-gfx";
constexpr double kMetricsWindowMs = 1000.0;
constexpr size_t kMaskAgeWindowSize = 30u;

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
};

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

void remapAlphaSmoothstep(AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return;
  }

  for (uint8_t &alpha : mask.alpha) {
    const float normalizedAlpha = static_cast<float>(alpha) / 255.0f;
    alpha = static_cast<uint8_t>(std::round(smoothstep(kSmoothstepLow, kSmoothstepHigh, normalizedAlpha) * 255.0f));
  }
}

void dilateAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> dilatedAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t maxAlpha = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        maxAlpha = std::max(maxAlpha, mask.alpha[static_cast<size_t>(y) * mask.width + sampleX]);
      }
      horizontalAlpha[static_cast<size_t>(y) * mask.width + x] = maxAlpha;
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t maxAlpha = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        maxAlpha = std::max(maxAlpha, horizontalAlpha[static_cast<size_t>(sampleY) * mask.width + x]);
      }
      dilatedAlpha[static_cast<size_t>(y) * mask.width + x] = maxAlpha;
    }
  }

  mask.alpha = std::move(dilatedAlpha);
}

std::vector<uint8_t> erodedAlphaForRadius(const AlphaMask &mask, uint32_t radius) {
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> erodedAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t minAlpha = 255u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        minAlpha = std::min(minAlpha, mask.alpha[static_cast<size_t>(y) * mask.width + sampleX]);
      }
      horizontalAlpha[static_cast<size_t>(y) * mask.width + x] = minAlpha;
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t minAlpha = 255u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        minAlpha = std::min(minAlpha, horizontalAlpha[static_cast<size_t>(sampleY) * mask.width + x]);
      }
      erodedAlpha[static_cast<size_t>(y) * mask.width + x] = minAlpha;
    }
  }

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

void featherAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> featheredAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        sumAlpha += mask.alpha[static_cast<size_t>(y) * mask.width + sampleX];
        ++sampleCount;
      }
      horizontalAlpha[static_cast<size_t>(y) * mask.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        sumAlpha += horizontalAlpha[static_cast<size_t>(sampleY) * mask.width + x];
        ++sampleCount;
      }
      featheredAlpha[static_cast<size_t>(y) * mask.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  mask.alpha = std::move(featheredAlpha);
}

std::vector<uint8_t> alphaProtectionMask(const AlphaMask &mask, uint32_t radius) {
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> sourceMask(pixelCount);
  std::vector<uint8_t> horizontalMask(pixelCount);
  std::vector<uint8_t> protectionMask(pixelCount);

  for (size_t index = 0; index < pixelCount; ++index) {
    sourceMask[index] = mask.alpha[index] >= kTemporalProtectionAlphaThreshold ? 1u : 0u;
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        if (sourceMask[static_cast<size_t>(y) * mask.width + sampleX] != 0u) {
          horizontalMask[static_cast<size_t>(y) * mask.width + x] = 1u;
          break;
        }
      }
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        if (horizontalMask[static_cast<size_t>(sampleY) * mask.width + x] != 0u) {
          protectionMask[static_cast<size_t>(y) * mask.width + x] = 1u;
          break;
        }
      }
    }
  }

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

  AlphaMask previous = previousMask;
  remapAlphaSmoothstep(previous);

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

    const uint8_t previousAlpha = previous.alpha[index];
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

void applyLatestAlphaToCurrentFrame(const VideoFrame &currentFrame,
                                    const AlphaMask &latestMask,
                                    VideoFrame &outputFrame) {
  outputFrame = currentFrame;
  if (currentFrame.rgba.empty() ||
      latestMask.alpha.empty() ||
      currentFrame.width == 0u ||
      currentFrame.height == 0u ||
      latestMask.width == 0u ||
      latestMask.height == 0u) {
    return;
  }

  std::vector<MaskSample> xSamples(currentFrame.width);
  std::vector<MaskSample> ySamples(currentFrame.height);
  buildMaskSamples(currentFrame.width, currentFrame.height, latestMask, xSamples, ySamples);

  for (uint32_t y = 0; y < currentFrame.height; ++y) {
    for (uint32_t x = 0; x < currentFrame.width; ++x) {
      const size_t frameOffset = (static_cast<size_t>(y) * currentFrame.width + x) * 4u;
      outputFrame.rgba[frameOffset + 3u] = sampleMaskBilinear(latestMask, xSamples, ySamples, x, y);
    }
  }
}

class AsyncKeyerWorker {
 public:
  AsyncKeyerWorker(const Options &options, MeetingState &state, std::atomic<bool> &running)
      : keyerChain_(options), state_(state), running_(running), thread_(&AsyncKeyerWorker::run, this) {}

  ~AsyncKeyerWorker() {
    stop();
  }

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

  bool copyLatest(PairedKeyerFrame &pair) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasLatestPair_) {
      return false;
    }
    pair = latestPair_;
    return true;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++generation_;
    hasPendingFrame_ = false;
    hasLatestPair_ = false;
    droppedFrames_ = 0;
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
    return KeyerRuntimeStats{keyerRate_.value(now), droppedFramesPerSec_, droppedFrames_};
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
      AlphaMask previousMask;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (hasLatestPair_) {
          previousMask = latestPair_.mask;
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
          keyed.status.metrics.keyerFps = keyerRate_.value(now);
          keyed.status.metrics.droppedFramesPerSec = droppedFramesPerSec_;
          keyed.status.metrics.keyerInputAgeMs = frame.timestampNs > 0u && keyerStartNs >= frame.timestampNs
              ? static_cast<double>(keyerStartNs - frame.timestampNs) / 1000000.0
              : -1.0;
          keyed.status.metrics.keyerProcessingMs = publishNs >= keyerStartNs
              ? static_cast<double>(publishNs - keyerStartNs) / 1000000.0
              : -1.0;
          latestPair_.frame = std::move(frame);
          latestPair_.mask = std::move(keyed.mask);
          latestPair_.publishedAtNs = publishNs;
          hasLatestPair_ = !latestPair_.mask.alpha.empty();
        }
      }
      if (shouldPublish) {
        updateMeetingKeyerStatus(state_, keyed.status);
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
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
  VideoFrame pendingFrame_;
  PairedKeyerFrame latestPair_;
  uint64_t generation_ = 0;
  uint64_t pendingGeneration_ = 0;
  uint64_t droppedFrames_ = 0;
  RateMeter keyerRate_;
  std::chrono::steady_clock::time_point lastDropRateSample_{};
  uint64_t lastDropRateTotal_ = 0u;
  double droppedFramesPerSec_ = -1.0;
  bool hasPendingFrame_ = false;
  bool hasLatestPair_ = false;
  bool stopping_ = false;
};

class GraphicsFrameBusReader {
 public:
  ~GraphicsFrameBusReader() {
    close();
  }

  bool copyLatest(VideoFrame &frame) {
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

    scratch_.assign(static_cast<size_t>(width) * height * 4u, 0u);
    const int result = framebus_reader_copy_latest_rgba(reader_, scratch_.data(), static_cast<size_t>(width) * 4u, &lastSeq_);
    if (result == -1) {
      logReaderEvent("copy_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }
    if (result == 1) {
      uint64_t nonTransparentPixels = 0;
      uint32_t maxAlpha = 0;
      for (size_t index = 3; index < scratch_.size(); index += 4u) {
        const uint32_t alpha = scratch_[index];
        if (alpha > 0u) {
          ++nonTransparentPixels;
          maxAlpha = std::max(maxAlpha, alpha);
        }
      }
      latestFrame_.width = width;
      latestFrame_.height = height;
      latestFrame_.timestampNs = nowNs();
      latestFrame_.rgba = scratch_;
      hasLatestFrame_ = true;
      logReaderEvent("frame_read", width, height, fps, nonTransparentPixels, maxAlpha);
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
    reader_ = framebus_reader_open(kMeetingGraphicsFrameBusName);
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
              << "\",\"name\":\"" << kMeetingGraphicsFrameBusName
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
  AsyncKeyerWorker keyerWorker(options, state, running);
  GraphicsFrameBusReader graphicsReader;
  RateMeter programRate;
  RollingAverage maskAgeAverage;
  uint64_t previousProgramStartNs = 0u;
  while (running.load()) {
    bool framebusRunning = true;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      framebusRunning = state.framebusRunning;
      state.cameraRunning = camera.isRunning();
      state.activeCameraIndex = camera.activeCameraIndex();
    }

    if (framebusRunning) {
      const auto programStart = std::chrono::steady_clock::now();
      const uint64_t programStartNs = nowNs();
      const double programFrameIntervalMs = previousProgramStartNs > 0u && programStartNs >= previousProgramStartNs
          ? static_cast<double>(programStartNs - previousProgramStartNs) / 1000000.0
          : -1.0;
      previousProgramStartNs = programStartNs;
      VideoFrame frame;
      const auto cameraCopyStart = std::chrono::steady_clock::now();
      const bool hasCameraFrame = camera.copyLatestFrame(frame) && !frame.rgba.empty();
      const auto cameraCopyEnd = std::chrono::steady_clock::now();
      VideoFrame keyedFrame;
      const VideoFrame *frameForCompositor = nullptr;
      PairedKeyerFrame selectedPair;
      bool hasSelectedPair = false;
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
      if (hasCameraFrame && keyerEnabled) {
        keyerWorker.submit(frame);
      }
      const CompositorSnapshot snapshot = copyCompositorSnapshot(state);
      if (hasCameraFrame) {
        if (snapshot.keyerEnabled) {
          PairedKeyerFrame latestPair;
          if (keyerWorker.copyLatest(latestPair)) {
            double maskAgeMs = 0.0;
            if (frame.timestampNs >= latestPair.frame.timestampNs) {
              maskAgeMs = static_cast<double>(frame.timestampNs - latestPair.frame.timestampNs) / 1000000.0;
            }
            maskAgeAverage.add(maskAgeMs);
            const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
            if (pairIsUsable) {
              applyLatestAlphaToCurrentFrame(latestPair.frame, latestPair.mask, keyedFrame);
              frameForCompositor = &keyedFrame;
              selectedPair = latestPair;
              hasSelectedPair = true;
            } else {
              frameForCompositor = &frame;
            }
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.keyerMetrics.maskAgeMs = maskAgeMs;
              state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
              state.keyerMetrics.keyerPublishToProgramMs = latestPair.publishedAtNs > 0u && programStartNs >= latestPair.publishedAtNs
                  ? static_cast<double>(programStartNs - latestPair.publishedAtNs) / 1000000.0
                  : -1.0;
              state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
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
            frameForCompositor = &frame;
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.degradationStage = "passthrough";
              state.staleMaskActive = false;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
              state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
              state.keyerMetrics.keyerFps = keyerStats.keyerFps;
            }
          }
        } else {
          keyerWorker.clear();
          maskAgeAverage.clear();
          frameForCompositor = &frame;
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
      VideoFrame graphicsFrame;
      const VideoFrame *graphicsFrameForCompositor = graphicsReader.copyLatest(graphicsFrame) ? &graphicsFrame : nullptr;
      if (hasCameraFrame && snapshot.keyerEnabled) {
        PairedKeyerFrame latestPair;
        if (keyerWorker.copyLatest(latestPair) &&
            (!hasSelectedPair || latestPair.publishedAtNs > selectedPair.publishedAtNs)) {
          double maskAgeMs = 0.0;
          if (frame.timestampNs >= latestPair.frame.timestampNs) {
            maskAgeMs = static_cast<double>(frame.timestampNs - latestPair.frame.timestampNs) / 1000000.0;
          }
          maskAgeAverage.add(maskAgeMs);
          const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
          if (pairIsUsable) {
            applyLatestAlphaToCurrentFrame(latestPair.frame, latestPair.mask, keyedFrame);
            frameForCompositor = &keyedFrame;
            selectedPair = latestPair;
            hasSelectedPair = true;
          } else {
            frameForCompositor = &frame;
            hasSelectedPair = false;
          }
          const KeyerRuntimeStats keyerStats = keyerWorker.stats();
          const uint64_t programUseNs = nowNs();
          {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.keyerMetrics.maskAgeMs = maskAgeMs;
            state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
            state.keyerMetrics.keyerPublishToProgramMs = latestPair.publishedAtNs > 0u && programUseNs >= latestPair.publishedAtNs
                ? static_cast<double>(programUseNs - latestPair.publishedAtNs) / 1000000.0
                : -1.0;
            state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
            state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
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
      renderProgramFrame(options, snapshot, frameForCompositor, graphicsFrameForCompositor, frameIndex++, programFrame);
      framebus_writer_write_rgba(writer, programFrame.data(), programFrame.size(), hasCameraFrame ? frame.timestampNs : nowNs());
      previewFrames.publish(options.width, options.height, programFrame.data(), programFrame.size());
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
    } else {
      keyerWorker.clear();
      maskAgeAverage.clear();
      previousProgramStartNs = 0u;
      nextFrameAt = std::chrono::steady_clock::now() + frameInterval;
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
