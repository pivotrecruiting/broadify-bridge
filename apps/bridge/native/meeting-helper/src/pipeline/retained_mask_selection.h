#pragma once

namespace broadify::meeting {

inline bool shouldUseRetainedMaskWhenFusedSkipped(bool fusedKeyerWorkDue,
                                                  bool hasCameraFrame,
                                                  bool keyerEnabled,
                                                  bool hasPreviousMask,
                                                  bool alreadyHasMask) {
  return !fusedKeyerWorkDue && hasCameraFrame && keyerEnabled &&
         hasPreviousMask && !alreadyHasMask;
}

}  // namespace broadify::meeting
