#include "capture/latest_frame_slot.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <set>

using broadify::meeting::LatestFrameSlot;
using broadify::meeting::VideoFrame;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "latest_frame_slot_test failed: " << what << std::endl;
  }
  return condition;
}

VideoFrame makeFrame(uint64_t timestampNs, size_t bytes) {
  VideoFrame frame;
  frame.width = 1u;
  frame.height = static_cast<uint32_t>(bytes / 4u);
  frame.timestampNs = timestampNs;
  frame.rgba.resize(bytes);
  return frame;
}

}  // namespace

int main() {
  bool ok = true;

  LatestFrameSlot slot;
  VideoFrame consumer = makeFrame(0u, 16u);
  ok &= expect(!slot.hasFrame(), "slot starts empty");
  ok &= expect(!slot.takeIfNew(0u, consumer), "empty take returns false");

  VideoFrame scratch = makeFrame(1u, 64u);
  const uint8_t *scratchData = scratch.rgba.data();
  slot.publish(std::move(scratch));
  ok &= expect(slot.hasFrame(), "publish marks the slot populated");
  ok &= expect(slot.hasFrameNewerThan(0u), "wait predicate sees a new frame");

  ok &= expect(slot.takeIfNew(0u, consumer), "first take succeeds");
  ok &= expect(consumer.timestampNs == 1u, "take transfers timestamp");
  ok &= expect(consumer.rgba.data() == scratchData,
               "take moves the published buffer to the consumer");
  ok &= expect(!slot.takeIfNew(0u, consumer), "take returns true once per publish");
  ok &= expect(!slot.takeIfNew(1u, consumer), "same timestamp take returns false");
  ok &= expect(!slot.hasFrameNewerThan(1u),
               "wait predicate parity after same timestamp");

  scratch.timestampNs = 2u;
  scratch.width = 1u;
  scratch.height = 16u;
  scratch.rgba.resize(64u);
  slot.publish(std::move(scratch));
  ok &= expect(slot.takeIfNew(1u, consumer), "second timestamp take succeeds");
  ok &= expect(consumer.timestampNs == 2u, "second take transfers timestamp");
  ok &= expect(!slot.hasFrameNewerThan(2u),
               "wait predicate tracks the latest published timestamp");

  scratch.timestampNs = 3u;
  scratch.width = 1u;
  scratch.height = 16u;
  scratch.rgba.resize(64u);
  slot.publish(std::move(scratch));
  ok &= expect(slot.takeIfNew(2u, consumer), "third timestamp warms rotation");

  for (uint64_t ts = 4u; ts < 20u; ++ts) {
    scratch.timestampNs = ts;
    scratch.width = 1u;
    scratch.height = 16u;
    scratch.rgba.resize(64u);
    slot.publish(std::move(scratch));
    ok &= expect(slot.takeIfNew(ts - 1u, consumer),
                 "take succeeds during warm-up");
  }

  std::set<const uint8_t *> steadyPointers;
  for (uint64_t ts = 20u; ts < 26u; ++ts) {
    scratch.timestampNs = ts;
    scratch.width = 1u;
    scratch.height = 16u;
    scratch.rgba.resize(64u);
    steadyPointers.insert(scratch.rgba.data());
    slot.publish(std::move(scratch));
    ok &= expect(slot.takeIfNew(ts - 1u, consumer),
                 "take succeeds while collecting steady buffers");
    steadyPointers.insert(consumer.rgba.data());
  }
  ok &= expect(steadyPointers.size() <= 3u,
               "steady-state rotation uses at most three buffers");

  for (uint64_t ts = 26u; ts < 40u; ++ts) {
    scratch.timestampNs = ts;
    scratch.width = 1u;
    scratch.height = 16u;
    scratch.rgba.resize(64u);
    ok &= expect(steadyPointers.count(scratch.rgba.data()) == 1u,
                 "scratch buffer identity is stable after warm-up");
    slot.publish(std::move(scratch));
    ok &= expect(slot.takeIfNew(ts - 1u, consumer),
                 "take succeeds for each new timestamp after warm-up");
    ok &= expect(steadyPointers.count(consumer.rgba.data()) == 1u,
                 "consumer buffer identity is stable after warm-up");
  }

  VideoFrame copied;
  ok &= expect(slot.copyIfNew(39u, copied) == false,
               "copyIfNew follows the same timestamp predicate");

  return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
