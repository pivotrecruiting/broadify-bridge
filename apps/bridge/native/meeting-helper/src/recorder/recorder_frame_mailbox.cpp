#include "recorder/recorder_frame_mailbox.h"

#include <cstring>

namespace broadify::meeting {

RecorderFrameMailbox::RecorderFrameMailbox(std::size_t capacity)
    : slots_(capacity == 0u ? 1u : capacity) {
  pendingOrder_.reserve(slots_.size());
}

bool RecorderFrameMailbox::offer(const uint8_t *rgba, uint32_t width,
                                 uint32_t height, uint64_t captureElapsedNs) {
  if (rgba == nullptr || width == 0u || height == 0u) {
    return false;
  }
  std::size_t slotIndex = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    ++counters_.offered;
    if (stopped_) {
      return false;
    }
    bool found = false;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      if (slots_[index].state == SlotState::Free) {
        slotIndex = index;
        found = true;
        break;
      }
    }
    if (!found) {
      // Every slot is pending (single producer: never one in Writing here):
      // latest wins, so the oldest pending frame is sacrificed.
      slotIndex = pendingOrder_.front();
      pendingOrder_.erase(pendingOrder_.begin());
      ++counters_.replaced;
    }
    slots_[slotIndex].state = SlotState::Writing;
  }

  // The copy runs without the lock: a Writing slot is invisible to the
  // consumer and only this (single) producer touches it.
  Slot &slot = slots_[slotIndex];
  const std::size_t bytes = static_cast<std::size_t>(width) * height * 4u;
  if (slot.frame.rgba.size() != bytes) {
    slot.frame.rgba.resize(bytes);
  }
  std::memcpy(slot.frame.rgba.data(), rgba, bytes);
  slot.frame.width = width;
  slot.frame.height = height;
  slot.frame.captureElapsedNs = captureElapsedNs;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    slot.state = SlotState::Pending;
    pendingOrder_.push_back(slotIndex);
    ++counters_.accepted;
  }
  pendingCv_.notify_one();
  return true;
}

bool RecorderFrameMailbox::takeLocked(RecorderMailboxFrame &frame) {
  if (pendingOrder_.empty()) {
    return false;
  }
  const std::size_t slotIndex = pendingOrder_.front();
  pendingOrder_.erase(pendingOrder_.begin());
  Slot &slot = slots_[slotIndex];
  // Swap buffers so the consumer's previous buffer becomes the slot's next
  // target: no allocation once every slot and the consumer are warmed up.
  frame.rgba.swap(slot.frame.rgba);
  frame.width = slot.frame.width;
  frame.height = slot.frame.height;
  frame.captureElapsedNs = slot.frame.captureElapsedNs;
  slot.state = SlotState::Free;
  return true;
}

bool RecorderFrameMailbox::take(RecorderMailboxFrame &frame) {
  std::unique_lock<std::mutex> lock(mutex_);
  pendingCv_.wait(lock, [this] { return !pendingOrder_.empty() || stopped_; });
  return takeLocked(frame);
}

bool RecorderFrameMailbox::tryTake(RecorderMailboxFrame &frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  return takeLocked(frame);
}

void RecorderFrameMailbox::stop() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_ = true;
  }
  pendingCv_.notify_all();
}

bool RecorderFrameMailbox::stopped() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return stopped_;
}

RecorderFrameMailbox::Counters RecorderFrameMailbox::counters() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return counters_;
}

std::size_t RecorderFrameMailbox::pending() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return pendingOrder_.size();
}

}  // namespace broadify::meeting
