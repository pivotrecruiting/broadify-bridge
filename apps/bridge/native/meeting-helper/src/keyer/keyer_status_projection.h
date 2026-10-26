#pragma once

#include "keyer/keyer.h"

#include <string>

namespace broadify::meeting {

// Makes a silent engine downgrade visible: when the fused keyer is degraded and the
// active keyer is the Vision fallback, report fallback_active=true with the
// degradation reason. Otherwise returns `status` unchanged.
//
// Pure (stdlib only). On macOS the fused CoreML MODNet keyer is the production
// keyer independent of the requested model (the webapp never sends one, so
// MeetingState::requestedKeyerModel stays at its Vision default); the program
// loop stores the fused failure reason in MeetingState::fusedDegradedReason and
// the async Vision worker then reports fallbackActive=false for its own frames,
// which used to hide the downgrade. `activeKeyer` is kept (Vision really runs).
KeyerStatus projectFusedDegradation(KeyerStatus status, const std::string &fusedDegradedReason);

}  // namespace broadify::meeting
