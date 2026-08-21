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
  using broadify::meeting::isCameraFrameStalled;

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

  std::cout << "frame_pipeline_stall_test passed" << std::endl;
  return 0;
}
