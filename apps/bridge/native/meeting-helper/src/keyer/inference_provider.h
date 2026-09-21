#pragma once

#include <string_view>

namespace broadify::meeting {

// True when keyer inference runs off-CPU (GPU/NPU execution provider): the
// async worker's duty-cycle cooldown protects CPU headroom that such a pass
// never consumes, so it would only add mask-age latency. Exact allowlist —
// unknown providers default to CPU-bound (cooldown stays on), and
// "openvino-cpu" is deliberately absent.
inline bool isGpuInferenceProvider(std::string_view provider) {
  return provider == "coreml" || provider == "directml" ||
         provider == "openvino-gpu" || provider == "openvino-npu";
}

}  // namespace broadify::meeting
