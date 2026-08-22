#pragma once

#include <cstdint>
#include <vector>

namespace broadify::meeting {

struct GpuFrameSlot {
  uint32_t index = 0;
  uint64_t fenceValue = 0;
};

class GpuFrameRing {
 public:
  explicit GpuFrameRing(uint32_t depth = 3);

  uint32_t depth() const { return depth_; }
  uint64_t nextFenceValue() const { return nextFenceValue_; }
  const GpuFrameSlot &current() const;
  const GpuFrameSlot &slot(uint32_t index) const;

  GpuFrameSlot acquireNext();
  void markSignaled(uint32_t index, uint64_t fenceValue);
  bool slotReady(uint32_t index, uint64_t completedFenceValue) const;
  uint32_t nextIndexAfter(uint32_t index) const;
  void reset();

 private:
  uint32_t depth_ = 3;
  uint32_t cursor_ = 0;
  uint64_t nextFenceValue_ = 1;
  std::vector<GpuFrameSlot> slots_;
};

}  // namespace broadify::meeting
