#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "preview/preview_frame_store.h"
#include "preview/vcam_shm_ring_win.h"
#if defined(_WIN32)
#include "preview/vcam_shm_publisher.h"
#endif
#include "state/meeting_state.h"

#include <algorithm>
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

struct CameraStallReopenBackoff {
  uint32_t consecutiveStallWindows = 0u;
  uint32_t reopenCount = 0u;
  std::chrono::steady_clock::time_point lastReopenAt{};
  std::chrono::steady_clock::duration nextDelay = std::chrono::seconds(5);
};

inline bool shouldReopenStalledCamera(
    CameraStallReopenBackoff &backoff,
    std::chrono::steady_clock::time_point now,
    bool stalledWindowElapsed,
    bool vcamClientConnected,
    double observedCameraFps) {
  if (!stalledWindowElapsed) {
    backoff.consecutiveStallWindows = 0u;
    return false;
  }
  if (vcamClientConnected && observedCameraFps >= 10.0) {
    return false;
  }
  ++backoff.consecutiveStallWindows;
  if (backoff.consecutiveStallWindows < 2u) {
    return false;
  }
  if (backoff.lastReopenAt != std::chrono::steady_clock::time_point{} &&
      now - backoff.lastReopenAt < backoff.nextDelay) {
    return false;
  }
  backoff.lastReopenAt = now;
  ++backoff.reopenCount;
  backoff.consecutiveStallWindows = 0u;
  if (backoff.reopenCount > 1u) {
    backoff.nextDelay = std::min<std::chrono::steady_clock::duration>(
        backoff.nextDelay * 2, std::chrono::seconds(30));
  }
  return true;
}

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      VcamShmRingWin *vcamShm,
#if defined(_WIN32)
                      VcamShmPublisher *vcamShmPublisher,
#endif
                      MeetingRecorder &recorder,
                      std::atomic<bool> &running);

}  // namespace broadify::meeting
