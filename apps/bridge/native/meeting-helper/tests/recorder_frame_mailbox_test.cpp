// Covers the single-producer/single-consumer "latest wins" mailbox that moves
// program frames from the pipeline tick to the macOS recorder worker thread.

#include "recorder/recorder_frame_mailbox.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <set>
#include <thread>
#include <vector>

using broadify::meeting::RecorderFrameMailbox;
using broadify::meeting::RecorderMailboxFrame;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recorder_frame_mailbox_test failed: " << what << std::endl;
  }
  return condition;
}

constexpr uint32_t kWidth = 8;
constexpr uint32_t kHeight = 4;
constexpr std::size_t kBytes = static_cast<std::size_t>(kWidth) * kHeight * 4u;

std::vector<uint8_t> pattern(uint8_t seed) {
  std::vector<uint8_t> bytes(kBytes);
  for (std::size_t i = 0; i < kBytes; ++i) {
    bytes[i] = static_cast<uint8_t>(seed + i);
  }
  return bytes;
}

bool matchesPattern(const RecorderMailboxFrame &frame, uint8_t seed) {
  if (frame.rgba.size() != kBytes) {
    return false;
  }
  const std::vector<uint8_t> expected = pattern(seed);
  return std::memcmp(frame.rgba.data(), expected.data(), kBytes) == 0;
}

}  // namespace

int main() {
  bool ok = true;

  // Latest wins with capacity 2: three offers replace the oldest pending
  // frame, the consumer sees the last two in order.
  {
    RecorderFrameMailbox mailbox(2);
    ok &= expect(mailbox.capacity() == 2u, "capacity is reported");
    ok &= expect(mailbox.pending() == 0u, "mailbox starts empty");
    ok &= expect(mailbox.offer(pattern(1).data(), kWidth, kHeight, 1000u),
                 "first offer is accepted");
    ok &= expect(mailbox.offer(pattern(2).data(), kWidth, kHeight, 2000u),
                 "second offer is accepted");
    ok &= expect(mailbox.pending() == 2u, "two frames pending");
    ok &= expect(mailbox.offer(pattern(3).data(), kWidth, kHeight, 3000u),
                 "third offer is accepted by replacing the oldest");
    ok &= expect(mailbox.pending() == 2u, "capacity bounds the pending count");
    const RecorderFrameMailbox::Counters counters = mailbox.counters();
    ok &= expect(counters.offered == 3u && counters.accepted == 3u &&
                     counters.replaced == 1u,
                 "counters: offered 3, accepted 3, replaced 1");

    RecorderMailboxFrame frame;
    ok &= expect(mailbox.tryTake(frame), "first take succeeds");
    ok &= expect(frame.captureElapsedNs == 2000u,
                 "first taken frame is the second offer (oldest was replaced)");
    ok &= expect(frame.width == kWidth && frame.height == kHeight,
                 "geometry travels with the frame");
    ok &= expect(matchesPattern(frame, 2), "second offer's bytes are intact");
    ok &= expect(mailbox.tryTake(frame), "second take succeeds");
    ok &= expect(frame.captureElapsedNs == 3000u && matchesPattern(frame, 3),
                 "second taken frame is the latest offer");
    ok &= expect(!mailbox.tryTake(frame), "mailbox is empty after draining");
    ok &= expect(mailbox.pending() == 0u, "pending is zero after draining");
  }

  // Capture time is preserved exactly (it drives the CFR timeline), even when
  // the consumer takes while more offers arrive.
  {
    RecorderFrameMailbox mailbox(2);
    mailbox.offer(pattern(9).data(), kWidth, kHeight, 123456789012345ull);
    RecorderMailboxFrame frame;
    ok &= expect(mailbox.take(frame) && frame.captureElapsedNs == 123456789012345ull,
                 "captureElapsedNs is preserved");
  }

  // stop() wakes a consumer blocked in take() and lets it drain what is
  // still pending before returning false.
  {
    RecorderFrameMailbox mailbox(2);
    std::atomic<int> taken{0};
    std::atomic<bool> returnedFalse{false};
    std::thread consumer([&] {
      RecorderMailboxFrame frame;
      while (mailbox.take(frame)) {
        ++taken;
      }
      returnedFalse = true;
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    ok &= expect(!returnedFalse.load(), "consumer blocks while the mailbox is empty");
    mailbox.offer(pattern(4).data(), kWidth, kHeight, 10u);
    mailbox.stop();
    consumer.join();
    ok &= expect(returnedFalse.load(), "stop() wakes the blocked consumer");
    ok &= expect(taken.load() == 1, "frames pending at stop() are drained");
    ok &= expect(mailbox.stopped(), "mailbox reports stopped");
    ok &= expect(!mailbox.offer(pattern(5).data(), kWidth, kHeight, 20u),
                 "offers after stop() are rejected");
    const RecorderFrameMailbox::Counters counters = mailbox.counters();
    ok &= expect(counters.offered == 2u && counters.accepted == 1u,
                 "rejected offers count as offered but not accepted");
  }

  // stop() with two pending frames: both are delivered in order, then false.
  {
    RecorderFrameMailbox mailbox(2);
    mailbox.offer(pattern(6).data(), kWidth, kHeight, 1u);
    mailbox.offer(pattern(7).data(), kWidth, kHeight, 2u);
    mailbox.stop();
    RecorderMailboxFrame frame;
    ok &= expect(mailbox.take(frame) && frame.captureElapsedNs == 1u,
                 "drain delivers the older frame first");
    ok &= expect(mailbox.take(frame) && frame.captureElapsedNs == 2u,
                 "drain delivers the newer frame second");
    ok &= expect(!mailbox.take(frame), "drain ends with false");
  }

  // No allocation after warm-up: the slot buffers and the consumer's scratch
  // buffer are recycled, so after capacity + 1 distinct buffers every frame
  // the consumer receives reuses one of them (pointer identity).
  {
    RecorderFrameMailbox mailbox(2);
    RecorderMailboxFrame frame;
    std::set<const uint8_t *> buffers;
    // Warm-up: fill both slots and drain them three times so every slot and
    // the consumer's scratch buffer have been allocated once.
    for (uint8_t round = 0; round < 3; ++round) {
      mailbox.offer(pattern(round).data(), kWidth, kHeight, round);
      mailbox.offer(pattern(round).data(), kWidth, kHeight, round);
      for (int takeIndex = 0; takeIndex < 2; ++takeIndex) {
        ok &= expect(mailbox.take(frame) && matchesPattern(frame, round),
                     "warm-up round delivers the offered bytes");
        buffers.insert(frame.rgba.data());
      }
    }
    ok &= expect(buffers.size() <= 3u, "warm-up uses at most capacity + 1 buffers");
    for (uint8_t round = 3; round < 40; ++round) {
      mailbox.offer(pattern(round).data(), kWidth, kHeight, round);
      if (round % 3 == 0) {
        // Let the mailbox fill and replace so every slot gets exercised.
        mailbox.offer(pattern(round).data(), kWidth, kHeight, round);
        mailbox.offer(pattern(round).data(), kWidth, kHeight, round);
      }
      while (mailbox.tryTake(frame)) {
        ok &= expect(matchesPattern(frame, round), "steady-state bytes are intact");
        ok &= expect(buffers.count(frame.rgba.data()) == 1u,
                     "steady state reuses a warm-up buffer (no allocation)");
      }
    }
  }

  // Geometry change between offers resizes the slot (one allocation) but
  // the frame still carries the new geometry and bytes.
  {
    RecorderFrameMailbox mailbox(2);
    std::vector<uint8_t> small(4u * 2u * 4u, 0x5a);
    mailbox.offer(small.data(), 4, 2, 1u);
    RecorderMailboxFrame frame;
    ok &= expect(mailbox.take(frame) && frame.rgba.size() == small.size(),
                 "small frame is delivered with its byte size");
    mailbox.offer(pattern(8).data(), kWidth, kHeight, 2u);
    ok &= expect(mailbox.take(frame) && frame.width == kWidth &&
                     frame.height == kHeight && matchesPattern(frame, 8),
                 "larger frame after a geometry change is delivered intact");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "recorder_frame_mailbox_test passed" << std::endl;
  return 0;
}
