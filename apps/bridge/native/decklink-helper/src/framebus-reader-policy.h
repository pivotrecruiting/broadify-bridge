#pragma once

#include <cstdint>

namespace decklink_helper {

inline bool shouldReopenStaleReader(uint64_t nowNs,
                                    uint64_t lastProgressNs,
                                    uint64_t thresholdNs) {
  if (lastProgressNs == 0 || thresholdNs == 0 || nowNs < lastProgressNs) {
    return false;
  }
  return nowNs - lastProgressNs >= thresholdNs;
}

inline bool isTornRead(uint64_t seqBefore,
                       uint64_t seqAfter,
                       uint32_t slotCount) {
  if (seqBefore == 0 || seqAfter == seqBefore || slotCount == 0) {
    return false;
  }
  if (seqAfter < seqBefore) {
    return true;
  }
  if (slotCount == 1) {
    return true;
  }
  return seqAfter - seqBefore >= static_cast<uint64_t>(slotCount - 1);
}

}  // namespace decklink_helper
