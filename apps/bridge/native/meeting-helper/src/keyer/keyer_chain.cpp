#include "keyer/keyer_chain.h"

#include "keyer/modnet_keyer.h"
#if defined(__APPLE__)
#include "keyer/vision_keyer.h"
#endif

namespace broadify::meeting {
namespace {

#if defined(__APPLE__)
// Auto-quality thresholds: with inference above ~30ms the keyer cannot hold
// ~30fps with headroom, so the governor steps down to the "fast" tier (whose
// coarse masks the pipeline refines along the camera image afterwards).
constexpr double kAutoQualityMaxInferenceMs = 30.0;
constexpr uint64_t kAutoQualityMinSamples = 10u;
constexpr double kAutoQualityEmaWeight = 0.2;
#endif

}  // namespace

KeyerChain::KeyerChain(const Options &options)
    : options_{options.modelsDir},
      modnet_(std::make_unique<ModnetKeyer>(options_))
#if defined(__APPLE__)
      ,
      vision_(std::make_unique<VisionKeyer>())
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
  if (requestedModel == "vision_person_segmentation") {
    if (settings.performanceMode == "performance") {
      settings.qualityMode = "fast";
    } else if (settings.performanceMode == "balanced") {
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
