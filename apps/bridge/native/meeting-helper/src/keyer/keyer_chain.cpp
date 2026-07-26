#include "keyer/keyer_chain.h"

#include <cstdlib>
#include <string>

#include "keyer/modnet_keyer.h"
#if defined(__APPLE__)
#include "keyer/coreml_keyer.h"
#include "keyer/vision_keyer.h"
#endif

namespace broadify::meeting {
namespace {

// Backend override (BROADIFY_MEETING_KEYER_BACKEND=modnet|vision_person_segmentation).
// Forces the keyer backend regardless of what the webapp requested — used to A/B
// the MODNet matting backend against Apple Vision on macOS without touching the
// UI. Empty/unset keeps the requested backend.
std::string readKeyerBackendOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_BACKEND");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  return (v == "modnet" || v == "vision_person_segmentation" ||
          v == "coreml_modnet")
             ? v
             : "";
}

// Performance override (BROADIFY_MEETING_KEYER_PERFORMANCE=high_quality|balanced|
// performance). Drives the MODNet input resolution (512 / 320 / 256) so quality
// can be tested at full res regardless of what the webapp requested.
std::string readKeyerPerformanceOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_PERFORMANCE");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  return (v == "high_quality" || v == "balanced" || v == "performance") ? v : "";
}

#if defined(__APPLE__)
// Auto-quality thresholds: with inference above ~30ms the keyer cannot hold
// ~30fps with headroom, so the governor steps down to the "fast" tier (whose
// coarse masks the pipeline refines along the camera image afterwards).
constexpr double kAutoQualityMaxInferenceMs = 34.0;
constexpr uint64_t kAutoQualityMinSamples = 10u;
constexpr double kAutoQualityEmaWeight = 0.2;
// After degrading to "fast", periodically probe the better tier again: load
// spikes (exports, dev tooling) must not pin the session to coarse masks.
// The interval backs off exponentially so a machine that genuinely cannot hold
// "balanced" settles into "fast" instead of re-probing (and visibly wobbling
// quality) every minute; a probe that holds resets it to the base interval.
constexpr auto kAutoQualityBaseReprobeInterval = std::chrono::seconds(60);
constexpr auto kAutoQualityMaxReprobeInterval = std::chrono::seconds(600);
// Consecutive "balanced" samples that must pass without re-degrading before a
// probe counts as successful (~1s at 30fps).
constexpr uint64_t kAutoQualityStableSamples = 30u;

// Manual quality override (BROADIFY_MEETING_KEYER_QUALITY=balanced|fast). When
// set it pins the Vision tier and bypasses the auto-governor entirely — useful
// on machines where "balanced" inference exceeds the 30fps budget but the async
// pipeline still holds the program at 30fps via mask reuse, so the finer masks
// are worth the slightly slower refresh. Empty/unset keeps the auto behavior.
std::string readKeyerQualityOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_QUALITY");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  return (v == "balanced" || v == "fast") ? v : "";
}
#endif

}  // namespace

KeyerChain::KeyerChain(const Options &options)
    : options_{options.modelsDir},
      modnet_(std::make_unique<ModnetKeyer>(options_))
#if defined(__APPLE__)
      ,
      vision_(std::make_unique<VisionKeyer>()),
      coreml_(std::make_unique<CoreMLKeyer>(options_.modelsDir))
#endif
{
  status_.activeKeyer = "passthrough";
  status_.backend = "passthrough";
  status_.fallbackActive = true;
  status_.fallbackReason = "keyer_disabled";
}

KeyerResult KeyerChain::process(const VideoFrame &input, const MeetingState &state) {
  bool enabled = false;
  std::string requestedModel;
  KeyerSettings settings;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    enabled = state.keyerEnabled;
    requestedModel = state.requestedKeyerModel;
    settings.qualityMode = state.qualityMode;
    settings.performanceMode = state.performanceMode;
    if (settings.performanceMode == "balanced") {
      settings.maxInputWidth = 960u;
      settings.maxInputHeight = 540u;
    } else if (settings.performanceMode == "performance") {
      settings.maxInputWidth = 640u;
      settings.maxInputHeight = 360u;
    }
    settings.maskErodePx = state.maskErodePx;
    settings.maskDilatePx = state.maskDilatePx;
    settings.maskFeatherPx = state.maskFeatherPx;
    settings.dynamicDilation = state.dynamicDilation;
    settings.temporalBlendEnabled = state.temporalBlendEnabled;
    settings.edgeStabilizationEnabled = state.edgeStabilizationEnabled;
    settings.edgeStabilizationStrength = state.edgeStabilizationStrength;
    settings.degradation = state.degradationSettings;
  }

  // Env override wins over the webapp's requested backend (read once, cached).
  static const std::string backendOverride = readKeyerBackendOverride();
  if (!backendOverride.empty()) {
    requestedModel = backendOverride;
  }
  static const std::string performanceOverride = readKeyerPerformanceOverride();
  if (!performanceOverride.empty()) {
    settings.performanceMode = performanceOverride;
  }

  std::lock_guard<std::mutex> lock(mutex_);
  if (!enabled) {
    KeyerResult result;
    status_.activeKeyer = "passthrough";
    status_.backend = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "keyer_disabled";
    status_.inferenceMs = -1.0;
    status_.metrics = KeyerMetrics{};
#if defined(__APPLE__)
    autoVisionQuality_ = "balanced";
    autoInferenceEmaMs_ = -1.0;
    autoInferenceSamples_ = 0;
    autoQualityReprobeInterval_ = kAutoQualityBaseReprobeInterval;
    autoQualityProbing_ = false;
#endif
    result.status = status_;
    return result;
  }

  if (requestedModel == "modnet") {
    KeyerResult result = modnet_->apply(input, settings);
    status_ = result.status;
    return result;
  }

#if defined(__APPLE__)
  if (requestedModel == "coreml_modnet") {
    KeyerResult result = coreml_->apply(input, settings);
    status_ = result.status;
    return result;
  }
  if (requestedModel == "vision_person_segmentation") {
    // Manual override wins over the governor (read once, cached).
    static const std::string qualityOverride = readKeyerQualityOverride();
    if (!qualityOverride.empty()) {
      settings.qualityMode = qualityOverride;
      KeyerResult result = vision_->apply(input, settings);
      status_ = result.status;
      return result;
    }
    if (settings.performanceMode == "performance") {
      settings.qualityMode = "fast";
    } else if (settings.performanceMode == "balanced") {
      if (autoVisionQuality_ == "fast" &&
          std::chrono::steady_clock::now() - autoQualityDegradedAt_ >= autoQualityReprobeInterval_) {
        // Retry "balanced". This run is a probe: if it degrades again the
        // interval backs off; if it holds, the interval resets.
        autoVisionQuality_ = "balanced";
        autoInferenceEmaMs_ = -1.0;
        autoInferenceSamples_ = 0;
        autoQualityProbing_ = true;
      }
      settings.qualityMode = autoVisionQuality_;
    }
    KeyerResult result = vision_->apply(input, settings);
    if (settings.performanceMode == "balanced" && !result.status.fallbackActive &&
        result.status.qualityMode == "balanced" && result.status.inferenceMs > 0.0) {
      autoInferenceEmaMs_ = autoInferenceEmaMs_ < 0.0
          ? result.status.inferenceMs
          : kAutoQualityEmaWeight * result.status.inferenceMs +
              (1.0 - kAutoQualityEmaWeight) * autoInferenceEmaMs_;
      ++autoInferenceSamples_;
      if (autoInferenceSamples_ >= kAutoQualityMinSamples &&
          autoInferenceEmaMs_ > kAutoQualityMaxInferenceMs) {
        autoVisionQuality_ = "fast";
        autoQualityDegradedAt_ = std::chrono::steady_clock::now();
        if (autoQualityProbing_) {
          // The probe failed — this machine still cannot hold "balanced", so
          // wait longer before the next retry (doubling, capped) to stop the
          // per-minute quality wobble.
          autoQualityReprobeInterval_ = std::min<std::chrono::steady_clock::duration>(
              autoQualityReprobeInterval_ * 2, kAutoQualityMaxReprobeInterval);
        }
        autoQualityProbing_ = false;
      } else if (autoQualityProbing_ &&
                 autoInferenceSamples_ >= kAutoQualityStableSamples) {
        // The probe held: "balanced" is sustainable again (e.g. a load spike
        // passed), so return to prompt retries next time.
        autoQualityReprobeInterval_ = kAutoQualityBaseReprobeInterval;
        autoQualityProbing_ = false;
      }
    }
    status_ = result.status;
    return result;
  }
#endif

  {
    KeyerResult result;
    status_.activeKeyer = "passthrough";
    status_.backend = requestedModel;
    status_.fallbackActive = true;
    status_.fallbackReason = "unsupported_model";
    status_.inferenceMs = -1.0;
    status_.metrics = KeyerMetrics{};
    result.status = status_;
    return result;
  }
}

KeyerStatus KeyerChain::status() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return status_;
}

void updateMeetingKeyerStatus(MeetingState &state, const KeyerStatus &status) {
  std::lock_guard<std::mutex> lock(state.mutex);
  state.activeKeyer = status.activeKeyer;
  state.fallbackActive = status.fallbackActive;
  state.fallbackReason = status.fallbackReason;
  state.keyerBackend = status.backend;
  state.activeQualityMode = status.qualityMode;
  state.provider = status.provider;
  state.modelPath = status.modelPath;
  state.inferenceMs = status.inferenceMs;
  state.modelHashOk = status.modelHashOk;
  KeyerMetrics mergedMetrics = status.metrics;
  mergedMetrics.cameraCopyMs = state.keyerMetrics.cameraCopyMs;
  mergedMetrics.maskAgeMs = state.keyerMetrics.maskAgeMs;
  mergedMetrics.maskAgeAvgMs = state.keyerMetrics.maskAgeAvgMs;
  mergedMetrics.keyerPublishToProgramMs = state.keyerMetrics.keyerPublishToProgramMs;
  mergedMetrics.programFrameIntervalMs = state.keyerMetrics.programFrameIntervalMs;
  mergedMetrics.programFrameMs = state.keyerMetrics.programFrameMs;
  mergedMetrics.mjpegEncodeMs = state.keyerMetrics.mjpegEncodeMs;
  mergedMetrics.programFps = state.keyerMetrics.programFps;
  state.keyerMetrics = mergedMetrics;
}

}  // namespace broadify::meeting
