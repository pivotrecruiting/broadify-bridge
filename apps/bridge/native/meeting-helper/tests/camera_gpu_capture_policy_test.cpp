#include "capture/camera_gpu_capture_policy.h"

#include <cassert>

using broadify::meeting::decideCameraGpuCapture;

int main() {
  auto disabled = decideCameraGpuCapture(false, false, false, false);
  assert(!disabled.useGpuCapture);
  assert(!disabled.fallbackToCpu);
  assert(disabled.reason == "disabled");

  auto noContext = decideCameraGpuCapture(true, false, true, true);
  assert(!noContext.useGpuCapture);
  assert(noContext.fallbackToCpu);
  assert(noContext.reason == "gpu_context_unavailable");

  auto noReader = decideCameraGpuCapture(true, true, false, true);
  assert(!noReader.useGpuCapture);
  assert(noReader.fallbackToCpu);
  assert(noReader.reason == "source_reader_unavailable");

  auto noFormat = decideCameraGpuCapture(true, true, true, false);
  assert(!noFormat.useGpuCapture);
  assert(noFormat.fallbackToCpu);
  assert(noFormat.reason == "dxgi_format_unavailable");

  auto gpu = decideCameraGpuCapture(true, true, true, true);
  assert(gpu.useGpuCapture);
  assert(!gpu.fallbackToCpu);
  return 0;
}
