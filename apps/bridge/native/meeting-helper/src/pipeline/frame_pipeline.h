#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <atomic>
#include <chrono>

namespace broadify::meeting {

class MeetingRecorder;

inline bool isCameraFrameStalled(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point lastFrameAt,
    std::chrono::steady_clock::time_point watchdogStartAt,
    std::chrono::milliseconds stallWindow) {
  if (watchdogStartAt == std::chrono::steady_clock::time_point{}) {
    return false;
  }
  const auto ageStart =
      lastFrameAt == std::chrono::steady_clock::time_point{}
          ? watchdogStartAt
          : lastFrameAt;
  return now - ageStart >= stallWindow;
}

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      std::atomic<bool> &running);

}  // namespace broadify::meeting
