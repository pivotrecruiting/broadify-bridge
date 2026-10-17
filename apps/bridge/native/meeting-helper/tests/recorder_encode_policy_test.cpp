#include "recorder/recorder_encode_policy.h"

#include <cmath>
#include <cstdint>
#include <iostream>

using broadify::meeting::RecorderFrameClock;
using broadify::meeting::recorderKeyframeInterval;
using broadify::meeting::recorderVideoBitrateBps;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recorder_encode_policy_test failed: " << what << std::endl;
  }
  return condition;
}

uint64_t nsForFrame(uint64_t frame, uint32_t fps) {
  return static_cast<uint64_t>(
      std::llround((static_cast<long double>(frame) * 1'000'000'000.0L) /
                   static_cast<long double>(fps)));
}

}  // namespace

int main() {
  bool ok = true;

  const uint64_t bitrate1080 = recorderVideoBitrateBps(1920, 1080, 30);
  ok &= expect(bitrate1080 >= 21'000'000ull &&
                   bitrate1080 <= 22'500'000ull,
               "1080p30 bitrate is about 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(1280, 720, 30) == 9'676'800ull,
               "720p30 bitrate is 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(3840, 2160, 30) == 40'000'000ull,
               "4K30 bitrate clamps to max");
  ok &= expect(recorderVideoBitrateBps(160, 90, 30) == 2'000'000ull,
               "tiny bitrate clamps to min");
  ok &= expect(recorderKeyframeInterval(30) == 60,
               "keyframe interval is two seconds");

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(0, 30));
    ok &= expect(plan.firstIndex == 0 && plan.count == 1 &&
                     !plan.discontinuity,
                 "first on-grid tick writes one frame");
    clock.commit(1);
    plan = clock.plan(nsForFrame(1, 30));
    ok &= expect(plan.firstIndex == 1 && plan.count == 1 &&
                     !plan.discontinuity,
                 "next on-grid tick writes one frame");
  }

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(2, 30));
    ok &= expect(plan.firstIndex == 0 && plan.count == 3 &&
                     !plan.discontinuity,
                 "three-frame gap is filled");
  }

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(5, 30));
    ok &= expect(plan.firstIndex == 0 && plan.count == 4 &&
                     !plan.discontinuity,
                 "six-frame gap caps first batch at four");
    clock.commit(4);
    plan = clock.plan(nsForFrame(5, 30));
    ok &= expect(plan.firstIndex == 4 && plan.count == 2 &&
                     !plan.discontinuity,
                 "six-frame gap fills the remainder next");
  }

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(45, 30));
    ok &= expect(plan.firstIndex == 45 && plan.count == 1 &&
                     plan.discontinuity,
                 "gap above one second jumps with discontinuity");
  }

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(1, 30));
    ok &= expect(plan.count == 2, "initial two-slot plan");
    clock.commit(2);
    plan = clock.plan(nsForFrame(1, 30));
    ok &= expect(plan.count == 0, "earlier tick writes no frame");
  }

  {
    RecorderFrameClock clock(30);
    auto plan = clock.plan(nsForFrame(3, 30));
    ok &= expect(plan.count == 4, "four slots planned");
    clock.commit(2);
    plan = clock.plan(nsForFrame(3, 30));
    ok &= expect(plan.firstIndex == 2 && plan.count == 2,
                 "uncommitted slots are planned again");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "recorder_encode_policy_test passed" << std::endl;
  return 0;
}
