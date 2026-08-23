#pragma once

#include <cstdint>

namespace broadify::meeting {

struct GuidedWorkSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

uint32_t guidedWorkWidthFromEnv();
GuidedWorkSize selectGuidedWorkSize(uint32_t sourceWidth, uint32_t sourceHeight,
                                    uint32_t maxWorkWidth);

}  // namespace broadify::meeting
