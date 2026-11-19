#include "capture/guarded_frame_slot.h"

#include <chrono>
#include <iostream>
#include <thread>

using broadify::meeting::GuardedFrameSlot;
using broadify::meeting::VideoFrame;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "guarded_frame_slot_test failed: " << what << std::endl;
  }
  return condition;
}

VideoFrame makeFrame(uint64_t timestampNs, uint8_t marker) {
  VideoFrame frame;
  frame.width = 2;
  frame.height = 2;
  frame.timestampNs = timestampNs;
  frame.rgba.assign(16u, marker);
  return frame;
}

}  // namespace

int main() {
  bool ok = true;
  GuardedFrameSlot slot;

  VideoFrame reusable;
  reusable.rgba.assign(64u, 7u);
  const uint8_t *reusableData = reusable.rgba.data();
  slot.publish(makeFrame(10u, 1u));
  ok &= expect(slot.takeIfNew(0u, reusable), "take returns fresh frame");
  ok &= expect(reusable.timestampNs == 10u && reusable.rgba.size() == 16u &&
                   reusable.rgba.data() != reusableData,
               "take swaps fresh frame into consumer");
  VideoFrame next = makeFrame(20u, 2u);
  const uint8_t *producerData = next.rgba.data();
  slot.publish(std::move(next));
  ok &= expect(next.rgba.data() == reusableData,
               "publish/take recycles consumer buffer into producer frame");
  ok &= expect(slot.takeIfNew(10u, reusable) &&
                   reusable.timestampNs == 20u &&
                   reusable.rgba.data() == producerData,
               "take receives the next frame");

  GuardedFrameSlot copySlot;
  copySlot.publish(makeFrame(100u, 3u));
  VideoFrame copied;
  ok &= expect(copySlot.copyIfNew(0u, copied) && copied.timestampNs == 100u,
               "copyIfNew returns newer timestamp");
  ok &= expect(!copySlot.copyIfNew(100u, copied),
               "copyIfNew honors timestamp");

  GuardedFrameSlot waitSlot;
  std::thread publisher([&waitSlot] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    waitSlot.publish(makeFrame(200u, 4u));
  });
  ok &= expect(waitSlot.waitForNewerThan(
                   0u, std::chrono::steady_clock::now() +
                           std::chrono::milliseconds(250)),
               "wait wakes on publish");
  publisher.join();
  ok &= expect(!waitSlot.waitForNewerThan(
                   200u, std::chrono::steady_clock::now() +
                             std::chrono::milliseconds(20)),
               "wait returns false at deadline");

  return ok ? 0 : 1;
}
