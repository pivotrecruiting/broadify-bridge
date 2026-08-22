#pragma once

#include "keyer/segmentation_tier.h"

#if defined(_WIN32)
struct IMFMediaSource;
struct IMFSample;
#endif

namespace broadify::meeting {

struct WindowsOsMaskProbeResult {
  bool propertyPresent = false;
  bool maskCapabilityPresent = false;
  std::string reason = "not_windows";
};

WindowsOsMaskProbeResult probeWindowsOsBackgroundMask();
void configureWindowsOsBackgroundSegmentation(bool enableMask);

#if defined(_WIN32)
WindowsOsMaskProbeResult attachWindowsOsBackgroundMaskSource(
    IMFMediaSource *source);
void detachWindowsOsBackgroundMaskSource(IMFMediaSource *source);
bool extractWindowsOsBackgroundMask(IMFSample *sample,
                                    uint32_t frameWidth,
                                    uint32_t frameHeight,
                                    uint64_t timestampNs,
                                    AlphaMask &out);
#endif

}  // namespace broadify::meeting
