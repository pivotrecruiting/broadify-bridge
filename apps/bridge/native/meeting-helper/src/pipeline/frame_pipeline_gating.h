#pragma once

#include <chrono>
#include <cstdint>

namespace broadify::meeting {

struct PipelineWorkTriggers {
  bool hasNewCameraFrame = false;
  bool programChanged = false;
  bool graphicsChanged = false;
  bool hasNewScreenFrame = false;
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
      double minIntervalFactor = 0.75);

std::chrono::steady_clock::time_point earlyCameraWakeRenderDeadline(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point lastRenderStartAt,
    std::chrono::steady_clock::time_point nextFrameAt,
    std::chrono::steady_clock::duration frameInterval,
    double minIntervalFactor = 0.75);

// Decides on every program tick whether the program frame goes to
// PreviewFrameStore, which feeds the virtual camera's raw stream, the WebRTC
// program stream and the MJPEG preview. Up to 30 fps (divisor 1) every
// rendered frame is published while a consumer is active. Above it the
// consumers get every second program frame (outputDivisor, ADR-0010).
//
// The decimation is time based, not tick parity: with a 30 fps camera in a
// 60 fps program every render can fall on an odd tick. A rendered frame that
// was held back stays pending, so the last picture is still published when
// the program goes static.
class PreviewPublishGate {
 public:
  PreviewPublishGate(std::chrono::steady_clock::duration frameInterval,
                     uint32_t outputDivisor);

  // Call once per program tick with the tick's start time. Returns whether
  // the current program frame is to be published now.
  bool shouldPublish(bool programRendered, bool consumerActive,
                     std::chrono::steady_clock::time_point tickStart);

 private:
  // Half a frame interval short of the output interval (25 ms at 60 fps,
  // 30 ms at 50 fps): tolerant of tick jitter, never two ticks in a row.
  const std::chrono::steady_clock::duration minPublishInterval_;
  const bool decimate_;
  bool pending_ = false;
  std::chrono::steady_clock::time_point lastPublishAt_{};
};

// Factor for the fused keyer's dropout holds, which count keyer runs: one per
// new camera frame the program takes, so at most the program rate. Above
// 30 runs per second the limits double (outputDivisor), which makes 50 and
// 60 fps hold as long as 25 and 30 fps do. A camera at half the program rate
// (30 fps in a 60 fps program) keeps the factor 1. The camera rate is rounded
// first: devices report 30 fps as 30.00003.
uint32_t fusedKeyerHoldScale(uint32_t programFps, double cameraFps);

}  // namespace broadify::meeting
