#pragma once

#include <string>

namespace broadify::meeting {

struct CameraGpuCaptureDecision {
  bool useGpuCapture = false;
  bool fallbackToCpu = false;
  std::string reason;
};

CameraGpuCaptureDecision decideCameraGpuCapture(bool gpuResidentEnabled,
                                                bool gpuContextAvailable,
                                                bool readerOpened,
                                                bool nativeDxgiFormat);

}  // namespace broadify::meeting
