#include "keyer/keyer_chain.h"

#include "keyer/modnet_keyer.h"
#if defined(__APPLE__)
#include "keyer/coreml_keyer.h"
#include "keyer/vision_keyer.h"
#endif

namespace broadify::meeting {

KeyerChain::KeyerChain(const Options &options)
    : options_{options.modelsDir},
      modnet_(std::make_unique<ModnetKeyer>(options_))
#if defined(__APPLE__)
      ,
      coreml_(std::make_unique<CoreMLKeyer>(options.modelsDir)),
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
  int cameraIndex = -1;
  std::string requestedModel;
  KeyerSettings settings;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    enabled = state.keyerEnabled;
    cameraIndex = state.activeCameraIndex;
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
#if defined(__APPLE__)
  if (enabled && (!lastEnabled_ || requestedModel != lastRequestedModel_ ||
                  cameraIndex != lastCameraIndex_)) {
    vision_ = std::make_unique<VisionKeyer>();
  }
#endif
  lastEnabled_ = enabled;
  lastRequestedModel_ = requestedModel;
  lastCameraIndex_ = cameraIndex;
  if (!enabled) {
    KeyerResult result;
    status_.activeKeyer = "passthrough";
    status_.backend = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "keyer_disabled";
    status_.inferenceMs = -1.0;
    status_.metrics = KeyerMetrics{};
    result.status = status_;
    return result;
  }

  if (requestedModel == "modnet") {
#if defined(__APPLE__)
    KeyerResult coremlResult = coreml_->apply(input, settings);
    if (!coremlResult.mask.alpha.empty() && !coremlResult.status.fallbackActive) {
      status_ = coremlResult.status;
      return coremlResult;
    }
#endif
    KeyerResult result = modnet_->apply(input, settings);
#if defined(__APPLE__)
    if (result.mask.alpha.empty() || result.status.fallbackActive) {
      KeyerResult visionResult = vision_->apply(input, settings);
      if (!visionResult.mask.alpha.empty() && !visionResult.status.fallbackActive) {
        visionResult.status.fallbackActive = true;
        visionResult.status.fallbackReason = "modnet_unavailable_using_vision";
        status_ = visionResult.status;
        return visionResult;
      }
    }
#endif
    status_ = result.status;
    return result;
  }

#if defined(__APPLE__)
  if (requestedModel == "vision_person_segmentation") {
    if (settings.performanceMode == "performance") {
      settings.qualityMode = "fast";
    }
    KeyerResult result = vision_->apply(input, settings);
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
