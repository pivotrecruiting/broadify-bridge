#include "keyer/keyer_status_projection.h"

namespace broadify::meeting {

namespace {
constexpr const char *kVisionKeyer = "vision_person_segmentation";
}  // namespace

KeyerStatus projectFusedDegradation(KeyerStatus status, const std::string &fusedDegradedReason) {
  if (fusedDegradedReason.empty() || status.activeKeyer != kVisionKeyer) {
    return status;
  }
  // Vision really is running (activeKeyer stays), but only because the fused
  // keyer failed: surface that as a fallback with the fused reason.
  status.fallbackActive = true;
  status.fallbackReason = fusedDegradedReason;
  return status;
}

}  // namespace broadify::meeting
