#pragma once

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace broadify::meeting {

// One program frame in transit from the pipeline tick to the recorder worker.
// The RGBA buffer is owned by the mailbox slots / the consumer's scratch
// frame and recycled by swapping, so steady-state traffic allocates nothing.
struct RecorderMailboxFrame {
  std::vector<uint8_t> rgba;
  uint32_t width = 0;
  uint32_t height = 0;
  // Capture time of the frame relative to the writer session start, taken on
  // the producing (tick) thread. Drives the CFR timeline on the consumer.
  uint64_t captureElapsedNs = 0;
};

// Single-producer/single-consumer "latest wins" mailbox with a small fixed
// capacity. A full mailbox replaces its OLDEST pending frame so the recorder
// always catches up to the newest program picture instead of falling behind
// (a slow encoder costs duplicates/drops, never a growing queue or a stalled
// program loop).
//
// offer() copies the frame outside the lock (the only lock-held work is slot
// bookkeeping), take() blocks until a frame is pending or stop() was called
// and swaps buffers with the caller's frame. After stop() the consumer still
// drains everything that is pending, then take() returns false.
class RecorderFrameMailbox {
 public:
  static constexpr std::size_t kDefaultCapacity = 2;

  struct Counters {
    uint64_t offered = 0;   // offer() calls
    uint64_t accepted = 0;  // offers stored in a slot (even if later replaced)
    uint64_t replaced = 0;  // pending frames overwritten before being taken
  };

  explicit RecorderFrameMailbox(std::size_t capacity = kDefaultCapacity);

  RecorderFrameMailbox(const RecorderFrameMailbox &) = delete;
  RecorderFrameMailbox &operator=(const RecorderFrameMailbox &) = delete;

  // Producer. Copies width*height*4 bytes. Returns false once stopped.
  bool offer(const uint8_t *rgba, uint32_t width, uint32_t height,
             uint64_t captureElapsedNs);

  // Consumer. Blocks until a frame is pending or the mailbox is stopped and
  // drained (false). The frame's buffer is swapped into the freed slot.
  bool take(RecorderMailboxFrame &frame);

  // Consumer, non-blocking variant of take().
  bool tryTake(RecorderMailboxFrame &frame);

  // Stops accepting offers and wakes a blocked consumer. Pending frames stay
  // takeable so the consumer can drain.
  void stop();

  bool stopped() const;
  Counters counters() const;
  std::size_t pending() const;
  std::size_t capacity() const { return slots_.size(); }

 private:
  enum class SlotState { Free, Writing, Pending };

  struct Slot {
    RecorderMailboxFrame frame;
    SlotState state = SlotState::Free;
  };

  bool takeLocked(RecorderMailboxFrame &frame);

  mutable std::mutex mutex_;
  std::condition_variable pendingCv_;
  std::vector<Slot> slots_;
  // Indices of pending slots in arrival order (capacity-bounded, reserved).
  std::vector<std::size_t> pendingOrder_;
  Counters counters_;
  bool stopped_ = false;
};

}  // namespace broadify::meeting
