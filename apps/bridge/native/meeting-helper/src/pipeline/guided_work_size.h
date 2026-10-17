#pragma once

#include "keyer/keyer_governor.h"

#include <cstdint>

namespace broadify::meeting {

struct GuidedWorkSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

uint32_t guidedWorkWidthFromEnv();
uint32_t guidedWorkWidth();
uint32_t guidedWorkWidthCapForTier(GovernorTier tier);
void setGuidedWorkWidthTierCap(uint32_t cap);
GuidedWorkSize selectGuidedWorkSize(uint32_t sourceWidth, uint32_t sourceHeight,
                                    uint32_t maxWorkWidth);

}  // namespace broadify::meeting
