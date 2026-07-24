#pragma once

#include "common/options.h"
#include "keyer/keyer.h"
#if defined(__APPLE__)
#include "keyer/coreml_keyer.h"
#endif
#include "keyer/modnet_keyer.h"
#include "state/meeting_state.h"

#include <chrono>
#include <mutex>
#include <memory>

namespace broadify::meeting {

class KeyerChain {
 public:
  explicit KeyerChain(const Options &options);

  KeyerResult process(const VideoFrame &input, const MeetingState &state);
  KeyerStatus status() const;

 private:
  mutable std::mutex mutex_;
  ModnetKeyerOptions options_;
  std::unique_ptr<Keyer> modnet_;
#if defined(__APPLE__)
  std::unique_ptr<Keyer> coreml_;
  // Apple Vision person segmentation is macOS-only and must never ship on
  // other platforms for licensing reasons; keep it out of non-Apple builds.
  std::unique_ptr<Keyer> vision_;
  // Native Core ML MODNet backend (zero-copy GPU rework, Stage 1). Opt-in via
  // BROADIFY_MEETING_KEYER_BACKEND=coreml_modnet; the model is MODNet.mlpackage
  // in the models dir.
  std::unique_ptr<Keyer> coreml_;
  // Auto-quality governor for the "balanced" profile: starts at Vision
  // "balanced" and drops to "fast" once the smoothed inference time shows the
  // machine cannot sustain it. Resets when the keyer is re-enabled.
  std::string autoVisionQuality_ = "balanced";
  double autoInferenceEmaMs_ = -1.0;
  uint64_t autoInferenceSamples_ = 0;
  std::chrono::steady_clock::time_point autoQualityDegradedAt_{};
  // Re-probe backoff: a machine that genuinely cannot hold "balanced" must not
  // retry every 60s (each retry visibly wobbles quality). The interval doubles
  // on every failed probe and resets once a probe holds. See keyer_chain.cpp.
  std::chrono::steady_clock::duration autoQualityReprobeInterval_{
      std::chrono::seconds(60)};
  bool autoQualityProbing_ = false;
#endif
  bool lastEnabled_ = false;
  std::string lastRequestedModel_;
  int lastCameraIndex_ = -1;
  KeyerStatus status_;
};

void updateMeetingKeyerStatus(MeetingState &state, const KeyerStatus &status);

}  // namespace broadify::meeting
