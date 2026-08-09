#pragma once

// OpenVINO matting backend: Windows-only and opt-in at build time
// (MEETING_HELPER_ENABLE_OPENVINO=1 -> BROADIFY_ENABLE_OPENVINO). The class
// only exists when compiled in; every consumer (matting_backend.cpp, the
// keyer self-test) guards its references with the same condition, and
// openvino_keyer.cpp compiles to an empty translation unit otherwise so the
// CMake source lists stay unconditional.
#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)

#include "keyer/matting_backend.h"

#include <memory>
#include <string>
#include <vector>

namespace broadify::meeting {

struct OpenVinoKeyerOptions {
  std::string modelsDir;
  // OpenVINO device selection string, e.g. "AUTO:NPU,GPU,CPU" or "GPU"
  // (see expandOpenVinoDeviceSelection in matting_backend.h).
  std::string device;
};

// MODNet matting via the OpenVINO runtime. Same contract as ModnetKeyer:
// performanceMode picks the input size (512/320/256 via matting_common), one
// compiled model per size (static shapes - MODNet on NPU requires them, and
// they dodge the per-run recompile trap the DirectML path documented), model
// integrity via models/manifest.json, and the 3-run warmup median exposed as
// probeInferenceMs to seed the fused auto-degradation governor.
class OpenVinoKeyer : public MattingKeyer {
 public:
  explicit OpenVinoKeyer(OpenVinoKeyerOptions options);
  ~OpenVinoKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
  KeyerStatus status() const override;

  // Device probe used by the factory policy. Throws when the OpenVINO runtime
  // itself cannot initialize (missing DLLs and the like) - the factory treats
  // that as "OpenVINO unavailable" and falls back.
  static std::vector<std::string> availableDevices();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting

#endif  // BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
