#pragma once

#include "keyer/segmentation_tier.h"

namespace broadify::meeting {

struct WindowsOsMaskProbeResult {
  bool propertyPresent = false;
  bool maskCapabilityPresent = false;
  std::string reason = "not_windows";
};

WindowsOsMaskProbeResult probeWindowsOsBackgroundMask();
void configureWindowsOsBackgroundSegmentation(bool enableMask);

}  // namespace broadify::meeting
