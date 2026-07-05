#pragma once

#include "common/options.h"
#include "keyer/keyer.h"
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
  // Apple Vision person segmentation is macOS-only and must never ship on
  // other platforms for licensing reasons; keep it out of non-Apple builds.
  std::unique_ptr<Keyer> vision_;
  // Auto-quality governor for the "balanced" profile: starts at Vision
  // "balanced" and drops to "fast" once the smoothed inference time shows the
  // machine cannot sustain it. Resets when the keyer is re-enabled.
  std::string autoVisionQuality_ = "balanced";
  double autoInferenceEmaMs_ = -1.0;
  uint64_t autoInferenceSamples_ = 0;
  std::chrono::steady_clock::time_point autoQualityDegradedAt_{};
#endif
  KeyerStatus status_;
};

void updateMeetingKeyerStatus(MeetingState &state, const KeyerStatus &status);

}  // namespace broadify::meeting
