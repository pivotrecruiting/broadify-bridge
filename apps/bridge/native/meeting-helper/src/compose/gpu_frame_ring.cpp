#include "compose/gpu_frame_ring.h"

#include <algorithm>

namespace broadify::meeting {

GpuFrameRing::GpuFrameRing(uint32_t depth)
    : depth_(std::max(1u, depth)), slots_(depth_) {
  for (uint32_t index = 0; index < depth_; ++index) {
    slots_[index].index = index;
  }
}

const GpuFrameSlot &GpuFrameRing::current() const {
  return slots_[cursor_];
}

const GpuFrameSlot &GpuFrameRing::slot(uint32_t index) const {
  return slots_[index % depth_];
}

GpuFrameSlot GpuFrameRing::acquireNext() {
  cursor_ = nextIndexAfter(cursor_);
  slots_[cursor_].fenceValue = nextFenceValue_++;
  return slots_[cursor_];
}

void GpuFrameRing::markSignaled(uint32_t index, uint64_t fenceValue) {
  GpuFrameSlot &target = slots_[index % depth_];
  target.fenceValue = fenceValue;
  if (fenceValue >= nextFenceValue_) {
    nextFenceValue_ = fenceValue + 1u;
  }
}

bool GpuFrameRing::slotReady(uint32_t index,
                             uint64_t completedFenceValue) const {
  const GpuFrameSlot &target = slot(index);
  return target.fenceValue == 0u || completedFenceValue >= target.fenceValue;
}

uint32_t GpuFrameRing::nextIndexAfter(uint32_t index) const {
  return (index + 1u) % depth_;
}

void GpuFrameRing::reset() {
  cursor_ = 0;
  nextFenceValue_ = 1;
  for (GpuFrameSlot &slot : slots_) {
    slot.fenceValue = 0;
  }
}

}  // namespace broadify::meeting
