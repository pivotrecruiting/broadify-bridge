#pragma once

#include <chrono>
#include <cstdint>

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

bool shouldSubmitAsyncKeyerFrame(bool hasNewCameraFrame,
                                 bool keyerEnabled,
                                 bool asyncPathActive,
                                 bool fusedWarmupInFlight,
                                 bool governorOffReducedActive,
                                 uint64_t frameIndex,
                                 uint32_t reducedCadenceFrames = 4u);

std::chrono::steady_clock::time_point clampFramePacingDeadline(
    std::chrono::steady_clock::time_point nextFrameAt,
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::duration frameInterval);

bool framePacingDeadlineReached(std::chrono::steady_clock::time_point now,
                                std::chrono::steady_clock::time_point nextFrameAt);

bool shouldRenderEarlyCameraWake(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point lastRenderStartAt,
    std::chrono::steady_clock::duration frameInterval,
    double minIntervalFactor = 0.9);

}  // namespace broadify::meeting
