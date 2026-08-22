#include "pipeline/frame_pipeline_gating.h"

namespace broadify::meeting {

bool shouldRunProgramWork(const PipelineWorkTriggers &triggers) {
  return triggers.hasNewCameraFrame || triggers.programChanged ||
         triggers.graphicsChanged;
}

bool shouldRunFusedKeyerWork(const PipelineWorkTriggers &triggers) {
  return triggers.hasNewCameraFrame;
}

bool shouldWriteFramebusFrame(bool framebusExplicitlyRunning,
                              bool hasProgramFrame,
                              bool programWorkRan,
                              bool heartbeatDue) {
  return framebusExplicitlyRunning && hasProgramFrame &&
         (programWorkRan || heartbeatDue);
}

bool shouldSubmitAsyncKeyerFrame(bool hasNewCameraFrame,
                                 bool keyerEnabled,
                                 bool asyncPathActive,
                                 bool fusedWarmupInFlight,
                                 bool governorOffReducedActive,
                                 uint64_t frameIndex,
                                 uint32_t reducedCadenceFrames) {
  if (!hasNewCameraFrame || !keyerEnabled || !asyncPathActive ||
      fusedWarmupInFlight) {
    return false;
  }
  if (!governorOffReducedActive) {
    return true;
  }
  const uint32_t cadence = reducedCadenceFrames == 0u ? 1u : reducedCadenceFrames;
  return frameIndex % cadence == 0u;
}

std::chrono::steady_clock::time_point clampFramePacingDeadline(
    std::chrono::steady_clock::time_point nextFrameAt,
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::duration frameInterval) {
  if (nextFrameAt > now + frameInterval) {
    return now + frameInterval;
  }
  if (nextFrameAt <= now) {
    return now;
  }
  return nextFrameAt;
}

bool framePacingDeadlineReached(std::chrono::steady_clock::time_point now,
                                std::chrono::steady_clock::time_point nextFrameAt) {
  return now >= nextFrameAt;
}

bool shouldRenderEarlyCameraWake(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point lastRenderStartAt,
    std::chrono::steady_clock::duration frameInterval,
    double minIntervalFactor) {
  if (lastRenderStartAt == std::chrono::steady_clock::time_point{}) {
    return true;
  }
  const auto minElapsed =
      std::chrono::duration_cast<std::chrono::steady_clock::duration>(
          std::chrono::duration<double>(frameInterval) * minIntervalFactor);
  return now - lastRenderStartAt >= minElapsed;
}

std::chrono::steady_clock::time_point earlyCameraWakeRenderDeadline(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point lastRenderStartAt,
    std::chrono::steady_clock::time_point nextFrameAt,
    std::chrono::steady_clock::duration frameInterval,
    double minIntervalFactor) {
  if (shouldRenderEarlyCameraWake(now, lastRenderStartAt, frameInterval,
                                  minIntervalFactor)) {
    return now;
  }
  const auto minElapsed =
      std::chrono::duration_cast<std::chrono::steady_clock::duration>(
          std::chrono::duration<double>(frameInterval) * minIntervalFactor);
  const auto earliestRenderAt = lastRenderStartAt + minElapsed;
  return earliestRenderAt < nextFrameAt ? earliestRenderAt : nextFrameAt;
}

}  // namespace broadify::meeting
