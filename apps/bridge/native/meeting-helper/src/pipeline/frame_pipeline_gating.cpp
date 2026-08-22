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

}  // namespace broadify::meeting
