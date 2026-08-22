#pragma once

#include "keyer/keyer.h"

namespace broadify::meeting {

enum class GovernorOffCompositorInput {
  LastMask,
  BackgroundOnly,
};

GovernorOffCompositorInput selectGovernorOffCompositorInput(bool hasLastGoodMask);

bool selectRetainedOrEmptyMaskForLiveKeyer(const AlphaMask &lastGoodMask,
                                           uint64_t currentFrameTimestampNs,
                                           uint32_t frameWidth,
                                           uint32_t frameHeight,
                                           AlphaMask &selectedMask,
                                           double maxRetainedAgeMs = 2000.0);

}  // namespace broadify::meeting
