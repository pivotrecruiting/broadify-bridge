#include "pipeline/guided_work_size.h"

#include <algorithm>
#include <cstdlib>

namespace broadify::meeting {
namespace {

constexpr uint32_t kDefaultMaskWorkWidth = 512u;

}  // namespace

uint32_t guidedWorkWidthFromEnv() {
  const char *raw = std::getenv("BROADIFY_MEETING_MASK_WORK_WIDTH");
  if (raw == nullptr || raw[0] == '\0') {
    return kDefaultMaskWorkWidth;
  }
  const int parsed = std::atoi(raw);
  if (parsed <= 0) {
    return kDefaultMaskWorkWidth;
  }
  return static_cast<uint32_t>(std::max(parsed, 1));
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
