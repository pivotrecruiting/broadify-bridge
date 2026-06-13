#include "keyer/keyer_chain.h"

#include "keyer/modnet_keyer.h"
#include "keyer/vision_keyer.h"

namespace broadify::meeting {

KeyerChain::KeyerChain(const Options &options)
    : options_{options.modelsDir},
      modnet_(std::make_unique<ModnetKeyer>(options_)),
      vision_(std::make_unique<VisionKeyer>()) {
  status_.activeKeyer = "passthrough";
  status_.backend = "passthrough";
  status_.fallbackActive = true;
  status_.fallbackReason = "keyer_disabled";
}

KeyerResult KeyerChain::process(const VideoFrame &input, const MeetingState &state) {
  bool enabled = false;
  std::string requestedModel;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    enabled = state.keyerEnabled;
    requestedModel = state.requestedKeyerModel;
  }

  std::lock_guard<std::mutex> lock(mutex_);
  if (!enabled) {
    KeyerResult result;
    result.frame = copyPassthroughFrame(input);
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
    KeyerResult result = modnet_->apply(input);
    status_ = result.status;
    return result;
  }

  if (requestedModel == "vision_person_segmentation") {
    KeyerResult result = vision_->apply(input);
    status_ = result.status;
    return result;
  }

  {
    KeyerResult result;
    result.frame = copyPassthroughFrame(input);
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
  state.qualityMode = status.qualityMode;
  state.provider = status.provider;
  state.modelPath = status.modelPath;
  state.inferenceMs = status.inferenceMs;
  state.modelHashOk = status.modelHashOk;
  state.keyerMetrics = status.metrics;
}

}  // namespace broadify::meeting
