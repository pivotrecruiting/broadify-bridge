#include "capture/camera_gpu_capture_policy.h"

namespace broadify::meeting {

CameraGpuCaptureDecision decideCameraGpuCapture(bool gpuResidentEnabled,
                                                bool gpuContextAvailable,
                                                bool readerOpened,
                                                bool nativeDxgiFormat) {
  if (!gpuResidentEnabled) {
    return CameraGpuCaptureDecision{false, false, "disabled"};
  }
  if (!gpuContextAvailable) {
    return CameraGpuCaptureDecision{false, true, "gpu_context_unavailable"};
  }
  if (!readerOpened) {
    return CameraGpuCaptureDecision{false, true, "source_reader_unavailable"};
  }
  if (!nativeDxgiFormat) {
    return CameraGpuCaptureDecision{false, true, "dxgi_format_unavailable"};
  }
  return CameraGpuCaptureDecision{true, false, ""};
}

}  // namespace broadify::meeting
