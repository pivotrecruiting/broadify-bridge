#include "pipeline/frame_pipeline.h"

#include <chrono>
#include <cstdlib>
#include <iostream>

namespace {

void expect(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "frame_pipeline_stall_test failed: " << message << std::endl;
    std::exit(1);
  }
}

}  // namespace

int main() {
  using namespace std::chrono;
  using broadify::meeting::CameraStallReopenBackoff;
  using broadify::meeting::isCameraFrameStalled;
  using broadify::meeting::shouldReopenStalledCamera;

  const auto base = steady_clock::time_point{} + seconds(10);
  const auto window = milliseconds(1500);

  expect(!isCameraFrameStalled(base + milliseconds(1499), {}, base, window),
         "watchdog-only age below window is fresh");
  expect(isCameraFrameStalled(base + milliseconds(1500), {}, base, window),
         "watchdog-only age at window is stalled");
  expect(!isCameraFrameStalled(base + milliseconds(2000), base + milliseconds(750),
                               base, window),
         "last frame resets age");
  expect(isCameraFrameStalled(base + milliseconds(2300), base + milliseconds(750),
                              base, window),
         "last frame age at window is stalled");
  expect(!isCameraFrameStalled(base + seconds(5), {}, {}, window),
         "unset watchdog never stalls");

  CameraStallReopenBackoff backoff;
  expect(!shouldReopenStalledCamera(backoff, base, true, false, 0.0),
         "first stall window does not reopen");
  expect(shouldReopenStalledCamera(backoff, base + seconds(3), true, false, 0.0),
         "second consecutive stall window reopens");
  expect(!shouldReopenStalledCamera(backoff, base + seconds(7), true, false, 0.0),
         "5s backoff suppresses immediate reopen");
  expect(shouldReopenStalledCamera(backoff, base + seconds(8), true, false, 0.0),
         "reopen allowed after 5s backoff");
  expect(!shouldReopenStalledCamera(backoff, base + seconds(20), true, false, 0.0),
         "next backoff grows to 10s and still needs a second window");
  expect(shouldReopenStalledCamera(backoff, base + seconds(21), true, false, 0.0),
         "second window after grown backoff reopens");
  expect(backoff.nextDelay == seconds(20), "backoff doubles after repeated reopen");
  CameraStallReopenBackoff vcamBackoff;
  expect(!shouldReopenStalledCamera(vcamBackoff, base, true, true, 10.0),
         "VCam with healthy frame rate suppresses reopen");
  expect(!shouldReopenStalledCamera(vcamBackoff, base + seconds(3), true, true, 10.0),
         "VCam suppression does not accumulate stall windows");
  expect(!shouldReopenStalledCamera(vcamBackoff, base + seconds(4), false, false, 0.0),
         "fresh frame clears consecutive stall windows");

  std::cout << "frame_pipeline_stall_test passed" << std::endl;
  return 0;
}
