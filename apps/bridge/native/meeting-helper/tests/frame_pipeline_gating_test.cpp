#include "pipeline/frame_pipeline_gating.h"

#include <chrono>
#include <iostream>

using broadify::meeting::PipelineWorkTriggers;
using broadify::meeting::clampFramePacingDeadline;
using broadify::meeting::framePacingDeadlineReached;
using broadify::meeting::shouldRenderEarlyCameraWake;
using broadify::meeting::shouldRunFusedKeyerWork;
using broadify::meeting::shouldRunProgramWork;
using broadify::meeting::shouldSubmitAsyncKeyerFrame;
using broadify::meeting::shouldWriteFramebusFrame;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "frame_pipeline_gating_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(!shouldRunProgramWork({}), "idle reused frame does not run");
  ok &= expect(shouldRunProgramWork({true, false, false}), "new camera runs");
  ok &= expect(shouldRunProgramWork({false, true, false}), "program change runs");
  ok &= expect(shouldRunProgramWork({false, false, true}), "graphics change runs");

  ok &= expect(shouldRunFusedKeyerWork({true, false, false}),
               "fused keyer runs on new camera");
  ok &= expect(!shouldRunFusedKeyerWork({false, true, true}),
               "fused keyer does not run on reused camera");

  ok &= expect(!shouldWriteFramebusFrame(false, true, true, true),
               "framebus kill switch blocks writes");
  ok &= expect(!shouldWriteFramebusFrame(true, false, true, true),
               "framebus needs a frame");
  ok &= expect(shouldWriteFramebusFrame(true, true, true, false),
               "framebus writes changed program");
  ok &= expect(shouldWriteFramebusFrame(true, true, false, true),
               "framebus writes heartbeat");
  ok &= expect(!shouldWriteFramebusFrame(true, true, false, false),
               "framebus skips idle non-heartbeat");

  ok &= expect(shouldSubmitAsyncKeyerFrame(true, true, true, false, false, 1),
               "async submit runs on active async path");
  ok &= expect(!shouldSubmitAsyncKeyerFrame(true, true, true, true, false, 1),
               "fused warmup gates async first load");
  ok &= expect(!shouldSubmitAsyncKeyerFrame(true, true, false, false, false, 1),
               "parked async path does not submit");
  ok &= expect(!shouldSubmitAsyncKeyerFrame(true, true, true, false, true, 1),
               "off reduced cadence skips non-cadence frame");
  ok &= expect(shouldSubmitAsyncKeyerFrame(true, true, true, false, true, 4),
               "off reduced cadence submits every fourth frame");

  using Clock = std::chrono::steady_clock;
  const auto epoch = Clock::time_point{};
  const auto interval = std::chrono::milliseconds(33);
  ok &= expect(clampFramePacingDeadline(epoch + interval,
                                        epoch + std::chrono::milliseconds(16),
                                        interval) == epoch + interval,
               "early camera wake keeps the fps floor");
  ok &= expect(clampFramePacingDeadline(epoch + std::chrono::milliseconds(100),
                                        epoch, interval) == epoch + interval,
               "far future deadline clamps to one interval");
  ok &= expect(clampFramePacingDeadline(epoch + std::chrono::milliseconds(10),
                                        epoch + std::chrono::milliseconds(20),
                                        interval) ==
                   epoch + std::chrono::milliseconds(20),
               "overrun skips catch-up bursts");
  ok &= expect(!framePacingDeadlineReached(epoch + std::chrono::milliseconds(16),
                                           epoch + interval),
               "early camera wake does not pass the floor");
  ok &= expect(framePacingDeadlineReached(epoch + interval, epoch + interval),
               "deadline passes at the floor");
  const auto priorRender = epoch + std::chrono::milliseconds(100);
  ok &= expect(!shouldRenderEarlyCameraWake(
                   priorRender + std::chrono::milliseconds(16), priorRender,
                   interval),
               "60fps camera wake before 90 percent skips");
  ok &= expect(shouldRenderEarlyCameraWake(
                   priorRender + std::chrono::milliseconds(30), priorRender,
                   interval),
               "camera wake after 90 percent renders immediately");
  ok &= expect(shouldRenderEarlyCameraWake(
                   epoch + std::chrono::milliseconds(1),
                   Clock::time_point{}, interval),
               "first camera wake renders without prior start");

  return ok ? 0 : 1;
}
