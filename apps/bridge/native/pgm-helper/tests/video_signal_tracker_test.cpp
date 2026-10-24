#include "signal/video_signal_tracker.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "video_signal_tracker_test failed: " << m << std::endl; std::exit(1); }

int main() {
  VideoSignalTracker tracker(1'000'000'000ULL, 30);
  if (!tracker.signal().noSignal) fail("starts without signal");
  const uint64_t frame = 16'683'350ULL;  // 59.94 fps
  uint64_t ts = 1'000'000ULL;
  bool changed = tracker.onFrame(1920, 1080, "nv12", ts);
  if (!changed || tracker.signal().noSignal || tracker.signal().width != 1920) fail("first frame");
  for (int i = 0; i < 20; ++i) {
    ts += frame;
    tracker.onFrame(1920, 1080, "nv12", ts);
  }
  if (tracker.signal().fpsNum != 60000 || tracker.signal().fpsDen != 1001) fail("59.94 not snapped");
  // Format change: 720p25.
  changed = tracker.onFrame(1280, 720, "nv12", ts + 40'000'000ULL);
  if (!changed || tracker.signal().height != 720) fail("format change not reported");
  ts += 40'000'000ULL;
  for (int i = 0; i < 10; ++i) {
    ts += 40'000'000ULL;
    changed = tracker.onFrame(1280, 720, "nv12", ts);
  }
  if (tracker.signal().fpsNum != 25 || tracker.signal().fpsDen != 1) fail("25 fps");
  if (tracker.onTick(ts + 500'000'000ULL)) fail("no-signal fired too early");
  if (!tracker.onTick(ts + 1'100'000'000ULL) || !tracker.signal().noSignal) fail("no-signal not fired");
  if (tracker.onTick(ts + 2'000'000'000ULL)) fail("no-signal reported twice");
  if (!tracker.onFrame(1280, 720, "nv12", ts + 3'000'000'000ULL) || tracker.signal().noSignal) fail("signal back");
  // Jittery 30 fps source (intervals 31..35 ms) snaps to 30 and stays there.
  VideoSignalTracker jittery(1'000'000'000ULL, 30);
  uint64_t jt = 1'000'000ULL;
  const uint64_t pattern[] = {31'000'000ULL, 35'000'000ULL, 33'000'000ULL, 32'000'000ULL, 34'000'000ULL};
  for (int i = 0; i < 40; ++i) {
    jt += pattern[i % 5];
    jittery.onFrame(1280, 720, "nv12", jt);
  }
  if (jittery.signal().fpsNum != 30 || jittery.signal().fpsDen != 1) fail("jittery 30 fps not snapped");
  bool flapped = false;
  for (int i = 0; i < 40; ++i) {
    jt += pattern[(i + 2) % 5];
    flapped = jittery.onFrame(1280, 720, "nv12", jt) || flapped;
  }
  if (flapped || jittery.signal().fpsNum != 30) fail("fps flapped on jitter");
  if (!tracker.markNoSignal() || tracker.markNoSignal()) fail("explicit no-signal idempotent");
  std::cout << "video_signal_tracker_test passed" << std::endl;
  return 0;
}
