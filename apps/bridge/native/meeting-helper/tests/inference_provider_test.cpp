#include "keyer/inference_provider.h"

#include <iostream>

using broadify::meeting::isGpuInferenceProvider;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "inference_provider_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(isGpuInferenceProvider("coreml"), "coreml is GPU");
  ok &= expect(isGpuInferenceProvider("directml"), "directml is GPU");
  ok &= expect(isGpuInferenceProvider("openvino-gpu"), "openvino-gpu is GPU");
  ok &= expect(isGpuInferenceProvider("openvino-npu"), "openvino-npu is NPU");
  ok &= expect(!isGpuInferenceProvider("openvino-cpu"),
               "openvino-cpu keeps the cooldown");
  ok &= expect(!isGpuInferenceProvider("cpu"), "cpu keeps the cooldown");
  ok &= expect(!isGpuInferenceProvider(""), "empty provider keeps the cooldown");
  ok &= expect(!isGpuInferenceProvider("passthrough"),
               "unknown provider keeps the cooldown");
  return ok ? 0 : 1;
}
