#include "pipeline/frame_pipeline_gating.h"

#include "common/output_rate.h"

#include <algorithm>
#include <cmath>

namespace broadify::meeting {

bool shouldRunProgramWork(const PipelineWorkTriggers &triggers) {
  return triggers.hasNewCameraFrame || triggers.programChanged ||
         triggers.graphicsChanged || triggers.hasNewScreenFrame;
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

PreviewPublishGate::PreviewPublishGate(
    std::chrono::steady_clock::duration frameInterval, uint32_t outputDivisor)
    : minPublishInterval_(frameInterval * (2u * outputDivisor - 1u) / 2u),
      decimate_(outputDivisor > 1u) {}

bool PreviewPublishGate::shouldPublish(
    bool programRendered, bool consumerActive,
    std::chrono::steady_clock::time_point tickStart) {
  if (!consumerActive) {
    // Nobody to publish for: a frame rendered now is not owed to a consumer
    // that connects later.
    pending_ = false;
    return false;
  }
  if (!decimate_) {
    return programRendered;
  }
  pending_ = pending_ || programRendered;
  if (!pending_ || tickStart - lastPublishAt_ < minPublishInterval_) {
    return false;
  }
  pending_ = false;
  lastPublishAt_ = tickStart;
  return true;
}

uint32_t fusedKeyerHoldScale(uint32_t programFps, double cameraFps) {
  return outputDivisor(
      std::min(static_cast<double>(programFps), std::round(cameraFps)));
}

}  // namespace broadify::meeting
