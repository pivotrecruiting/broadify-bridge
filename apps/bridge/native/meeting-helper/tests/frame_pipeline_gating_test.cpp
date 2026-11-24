#include "pipeline/frame_pipeline_gating.h"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <vector>

using broadify::meeting::PipelineWorkTriggers;
using broadify::meeting::PreviewPublishGate;
using broadify::meeting::clampFramePacingDeadline;
using broadify::meeting::earlyCameraWakeRenderDeadline;
using broadify::meeting::framePacingDeadlineReached;
using broadify::meeting::fusedKeyerHoldScale;
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

// Runs the gate over `ticks` program ticks of a program at `fps` and returns
// the tick indices it published on. `rendered(tick)` says whether the program
// rendered a new frame on that tick; `jitterMs(tick)` shifts its start.
template <typename Rendered, typename Jitter>
std::vector<int> publishedTicks(uint32_t fps, uint32_t divisor, int ticks,
                                Rendered rendered, Jitter jitterMs) {
  const auto interval =
      std::chrono::duration_cast<std::chrono::steady_clock::duration>(
          std::chrono::duration<double>(1.0 / fps));
  PreviewPublishGate gate(interval, divisor);
  const auto start = std::chrono::steady_clock::time_point{} +
                     std::chrono::hours(1);
  std::vector<int> published;
  for (int tick = 0; tick < ticks; ++tick) {
    const auto at =
        start + interval * tick +
        std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double, std::milli>(jitterMs(tick)));
    if (gate.shouldPublish(rendered(tick), /*consumerActive=*/true, at)) {
      published.push_back(tick);
    }
  }
  return published;
}

const auto kAlways = [](int) { return true; };
const auto kNoJitter = [](int) { return 0.0; };

}  // namespace

int main() {
  bool ok = true;

  // Preview publish gate. Up to 30 fps every rendered frame is published and
  // nothing else (today's behaviour).
  ok &= expect(publishedTicks(30, 1, 6, kAlways, kNoJitter) ==
                   std::vector<int>({0, 1, 2, 3, 4, 5}),
               "30 fps publishes every rendered frame");
  ok &= expect(publishedTicks(25, 1, 6, [](int tick) { return tick % 3 == 0; },
                              kNoJitter) == std::vector<int>({0, 3}),
               "25 fps publishes rendered frames only, no carry-over");
  // 60 -> 30 and 50 -> 25: every second program frame.
  ok &= expect(publishedTicks(60, 2, 8, kAlways, kNoJitter) ==
                   std::vector<int>({0, 2, 4, 6}),
               "60 fps publishes every second frame");
  ok &= expect(publishedTicks(50, 2, 8, kAlways, kNoJitter) ==
                   std::vector<int>({0, 2, 4, 6}),
               "50 fps publishes every second frame");
  // Tick jitter of a few milliseconds does not change the cadence.
  ok &= expect(publishedTicks(60, 2, 8, kAlways,
                              [](int tick) { return tick % 2 == 0 ? 4.0 : -4.0; }) ==
                   std::vector<int>({0, 2, 4, 6}),
               "60 fps cadence survives tick jitter");
  // A 30 fps camera in a 60 fps program renders on every other tick; when
  // those are the odd ticks, every one of them is still published.
  ok &= expect(publishedTicks(60, 2, 8, [](int tick) { return tick % 2 == 1; },
                              kNoJitter) == std::vector<int>({1, 3, 5, 7}),
               "renders on odd ticks only are all published");
  // The picture goes static right after a held-back frame: that last frame
  // is published on the next tick, then nothing more.
  ok &= expect(publishedTicks(60, 2, 8, [](int tick) { return tick <= 3; },
                              kNoJitter) == std::vector<int>({0, 2, 4}),
               "the last rendered frame is published after the picture goes static");
  ok &= expect(publishedTicks(60, 2, 8, [](int tick) { return tick <= 2; },
                              kNoJitter) == std::vector<int>({0, 2}),
               "a static picture publishes nothing further");
  {
    // Without a consumer nothing is published, and a frame rendered meanwhile
    // is not owed to a consumer that connects later.
    const auto interval = std::chrono::milliseconds(20);
    const auto start =
        std::chrono::steady_clock::time_point{} + std::chrono::hours(1);
    for (const uint32_t divisor : {1u, 2u}) {
      PreviewPublishGate gate(interval, divisor);
      ok &= expect(!gate.shouldPublish(true, false, start),
                   "no publish without a consumer");
      ok &= expect(!gate.shouldPublish(false, true, start + interval * 5),
                   "a frame rendered without a consumer is not published later");
      ok &= expect(gate.shouldPublish(true, true, start + interval * 6),
                   "the next rendered frame is published once a consumer is there");
    }
  }

  // Fused keyer hold scale: doubled only when the keyer runs above 30 times
  // per second, i.e. program AND camera above 30 fps.
  ok &= expect(fusedKeyerHoldScale(30, 30.0) == 1u && fusedKeyerHoldScale(25, 25.0) == 1u,
               "25 and 30 fps keep the hold limits");
  ok &= expect(fusedKeyerHoldScale(60, 60.00024) == 2u && fusedKeyerHoldScale(50, 50.0) == 2u,
               "50 and 60 fps double the hold limits");
  ok &= expect(fusedKeyerHoldScale(60, 30.00003) == 1u && fusedKeyerHoldScale(50, 25.0) == 1u,
               "a half-rate camera keeps the hold limits");
  ok &= expect(fusedKeyerHoldScale(30, 60.0) == 1u,
               "a faster camera cannot run the keyer above the program rate");
  ok &= expect(!shouldRunProgramWork({}), "idle reused frame does not run");
  ok &= expect(shouldRunProgramWork({true, false, false}), "new camera runs");
  ok &= expect(shouldRunProgramWork({false, true, false}), "program change runs");
  ok &= expect(shouldRunProgramWork({false, false, true}), "graphics change runs");
  ok &= expect(shouldRunProgramWork({false, false, false, true}),
               "new screen frame runs program work");

  ok &= expect(shouldRunFusedKeyerWork({true, false, false}),
               "fused keyer runs on new camera");
  ok &= expect(!shouldRunFusedKeyerWork({false, true, true}),
               "fused keyer does not run on reused camera");
  ok &= expect(!shouldRunFusedKeyerWork({false, false, false, true}),
               "fused keyer ignores screen-only frames");

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
                   priorRender + std::chrono::milliseconds(24), priorRender,
                   interval),
               "camera wake before 75 percent skips");
  ok &= expect(shouldRenderEarlyCameraWake(
                   priorRender + std::chrono::milliseconds(25), priorRender,
                   interval),
               "camera wake after 75 percent renders immediately");
  ok &= expect(shouldRenderEarlyCameraWake(
                   epoch + std::chrono::milliseconds(1),
                   Clock::time_point{}, interval),
               "first camera wake renders without prior start");
  const auto earlyWake = priorRender + std::chrono::milliseconds(16);
  const auto nextFrame = priorRender + interval;
  const auto earlyWakeDeadline = earlyCameraWakeRenderDeadline(
      earlyWake, priorRender, nextFrame, interval);
  ok &= expect(earlyWakeDeadline > priorRender + std::chrono::milliseconds(24) &&
                   earlyWakeDeadline < priorRender + std::chrono::milliseconds(25),
               "early camera wake waits until the 75 percent floor");
  ok &= expect(earlyWakeDeadline > earlyWake,
               "early camera wake iteration waits instead of spinning");
  ok &= expect(earlyCameraWakeRenderDeadline(
                   priorRender + std::chrono::milliseconds(25), priorRender,
                   nextFrame, interval) ==
                   priorRender + std::chrono::milliseconds(25),
               "late camera wake renders immediately");

  const auto fps60CameraInterval = std::chrono::milliseconds(16);
  const auto fps60Start = epoch + std::chrono::milliseconds(200);
  auto lastRenderAt = fps60Start;
  auto scheduledFrameAt = fps60Start + interval;
  auto cameraArrival = fps60Start + fps60CameraInterval;
  int rendered60FpsCameraFrames = 0;
  for (int cameraFrame = 1; cameraFrame <= 4; cameraFrame += 2) {
    const auto renderAt = earlyCameraWakeRenderDeadline(
        cameraArrival, lastRenderAt, scheduledFrameAt, interval);
    ok &= expect(renderAt > cameraArrival,
                 "60 fps camera waits while inference is still running");
    ok &= expect(shouldRunFusedKeyerWork({true, false, false}),
                 "60 fps camera render still runs fused inference");
    ++rendered60FpsCameraFrames;
    lastRenderAt = renderAt;
    scheduledFrameAt = renderAt + interval;
    cameraArrival = fps60Start + fps60CameraInterval * (cameraFrame + 2);
  }
  ok &= expect(rendered60FpsCameraFrames == 2,
               "60 fps camera is throttled to the 0.75-interval render floor");

  const auto fps30CameraArrival = epoch + interval;
  ok &= expect(earlyCameraWakeRenderDeadline(
                   fps30CameraArrival, epoch, epoch + interval, interval) ==
                   fps30CameraArrival,
               "30 fps camera renders on arrival");

  return ok ? 0 : 1;
}
