#include "pipeline/guided_work_size.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>

namespace broadify::meeting {
namespace {

constexpr uint32_t kDefaultMaskWorkWidth = 512u;
std::atomic<uint32_t> gGuidedWorkWidthTierCap{0u};

}  // namespace

uint32_t guidedWorkWidthFromEnv() {
  return guidedWorkWidth();
}

uint32_t guidedWorkWidth() {
  const char *raw = std::getenv("BROADIFY_MEETING_MASK_WORK_WIDTH");
  if (raw == nullptr || raw[0] == '\0') {
    const uint32_t cap = gGuidedWorkWidthTierCap.load(std::memory_order_relaxed);
    return cap == 0u ? kDefaultMaskWorkWidth : std::min(kDefaultMaskWorkWidth, cap);
  }
  const int parsed = std::atoi(raw);
  if (parsed <= 0) {
    const uint32_t cap = gGuidedWorkWidthTierCap.load(std::memory_order_relaxed);
    return cap == 0u ? kDefaultMaskWorkWidth : std::min(kDefaultMaskWorkWidth, cap);
  }
  return static_cast<uint32_t>(std::max(parsed, 1));
}

uint32_t guidedWorkWidthCapForTier(GovernorTier tier) {
  switch (tier) {
    case GovernorTier::Full512:
      return 0u;
    case GovernorTier::Balanced320:
      return 640u;
    case GovernorTier::Performance256:
    case GovernorTier::Lite256:
    case GovernorTier::Off:
      return 512u;
  }
  return 512u;
}

void setGuidedWorkWidthTierCap(uint32_t cap) {
  gGuidedWorkWidthTierCap.store(cap, std::memory_order_relaxed);
}

GuidedWorkSize selectGuidedWorkSize(uint32_t sourceWidth, uint32_t sourceHeight,
                                    uint32_t maxWorkWidth) {
  if (sourceWidth == 0u || sourceHeight == 0u || maxWorkWidth == 0u) {
    return {};
  }
  GuidedWorkSize size{sourceWidth, sourceHeight};
  if (size.width > maxWorkWidth) {
    const double scale = static_cast<double>(maxWorkWidth) /
                         static_cast<double>(size.width);
    size.width = maxWorkWidth;
    size.height = std::max<uint32_t>(
        1u, static_cast<uint32_t>(sourceHeight * scale + 0.5));
  }
  return size;
}

}  // namespace broadify::meeting
