#pragma once

#include <chrono>

namespace broadify::meeting {

struct PipelineWorkTriggers {
  bool hasNewCameraFrame = false;
  bool programChanged = false;
  bool graphicsChanged = false;
};

bool shouldRunProgramWork(const PipelineWorkTriggers &triggers);
bool shouldRunFusedKeyerWork(const PipelineWorkTriggers &triggers);
bool shouldWriteFramebusFrame(bool framebusExplicitlyRunning,
                              bool hasProgramFrame,
                              bool programWorkRan,
                              bool heartbeatDue);

std::chrono::steady_clock::time_point clampFramePacingDeadline(
    std::chrono::steady_clock::time_point nextFrameAt,
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::duration frameInterval);

bool framePacingDeadlineReached(std::chrono::steady_clock::time_point now,
                                std::chrono::steady_clock::time_point nextFrameAt);

}  // namespace broadify::meeting
