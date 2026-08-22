#include "pipeline/compositor_input_selection.h"

#include <cstddef>

namespace broadify::meeting {

GovernorOffCompositorInput selectGovernorOffCompositorInput(bool hasLastGoodMask) {
  return hasLastGoodMask ? GovernorOffCompositorInput::LastMask
                         : GovernorOffCompositorInput::BackgroundOnly;
}

bool selectRetainedOrEmptyMaskForLiveKeyer(const AlphaMask &lastGoodMask,
                                           uint64_t currentFrameTimestampNs,
                                           uint32_t frameWidth,
                                           uint32_t frameHeight,
                                           AlphaMask &selectedMask,
                                           double maxRetainedAgeMs) {
  selectedMask = AlphaMask{};
  if (!lastGoodMask.alpha.empty()) {
    const double ageMs =
        currentFrameTimestampNs >= lastGoodMask.timestampNs
            ? static_cast<double>(currentFrameTimestampNs -
                                  lastGoodMask.timestampNs) /
                  1000000.0
            : 0.0;
    if (ageMs <= maxRetainedAgeMs) {
      selectedMask = lastGoodMask;
      selectedMask.timestampNs = currentFrameTimestampNs;
      return true;
    }
  }
  if (frameWidth == 0u || frameHeight == 0u) {
    return false;
  }
  selectedMask.width = frameWidth;
  selectedMask.height = frameHeight;
  selectedMask.timestampNs = currentFrameTimestampNs;
  selectedMask.alpha.assign(static_cast<size_t>(frameWidth) * frameHeight, 0u);
  selectedMask.emptyValid = true;
  return true;
}

}  // namespace broadify::meeting
