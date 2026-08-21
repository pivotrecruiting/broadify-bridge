#include "keyer/matting_backend.h"

#include "keyer/modnet_keyer.h"

#include <cstdlib>
#include <iostream>
#include <utility>

#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
#include "keyer/openvino_keyer.h"
#endif

namespace broadify::meeting {
namespace {

bool hasPrefix(const std::string &value, const char *prefix) {
  return value.rfind(prefix, 0) == 0;
}

#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
// Runs the OpenVINO backend and permanently hands over to the ONNX Runtime
// (DirectML) backend when OpenVINO cannot load its model or keeps failing
// inference. Load-stage failures (model/hash/session problems) switch
// immediately; transient inference failures only after a few in a row, so a
// single hiccup does not throw away the faster backend.
class FallbackMattingKeyer final : public MattingKeyer {
 public:
  FallbackMattingKeyer(std::unique_ptr<MattingKeyer> primary,
                       std::unique_ptr<MattingKeyer> fallback)
      : primary_(std::move(primary)), fallback_(std::move(fallback)) {}

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override {
    if (!primary_) {
      return fallback_->apply(input, settings);
    }
    KeyerResult result = primary_->apply(input, settings);
    if (!result.status.fallbackActive) {
      consecutiveInferenceFailures_ = 0;
      return result;
    }
    const std::string &reason = result.status.fallbackReason;
    const bool transientFailure =
        reason == "inference_failed" || reason == "invalid_output";
    if (transientFailure) {
      ++consecutiveInferenceFailures_;
    }
    if (!transientFailure ||
        consecutiveInferenceFailures_ >= kMaxConsecutiveInferenceFailures) {
      // One structured line, then the ONNX Runtime backend takes over for the
      // rest of the process lifetime (the reason vocabulary matches the keyer
      // fallback reasons).
      std::cout << "{\"type\":\"matting_backend_fallback\","
                   "\"from\":\"openvino_modnet\",\"to\":\"modnet\","
                   "\"reason\":\"" << reason << "\"}" << std::endl;
      primary_.reset();
      return fallback_->apply(input, settings);
    }
    return result;
  }

  KeyerStatus status() const override {
    return primary_ ? primary_->status() : fallback_->status();
  }

  bool warmupForPerformanceMode(const std::string &performanceMode) override {
    // Forward to the currently active backend. primary_ is only ever reset
    // inside apply(), which never runs concurrently with a warmup (the fused
    // instance is idle while the async worker owns the path), so this read
    // is safe from the warmup thread.
    return primary_ ? primary_->warmupForPerformanceMode(performanceMode)
                    : fallback_->warmupForPerformanceMode(performanceMode);
  }

 private:
  static constexpr int kMaxConsecutiveInferenceFailures = 3;
  std::unique_ptr<MattingKeyer> primary_;
  std::unique_ptr<MattingKeyer> fallback_;
  int consecutiveInferenceFailures_ = 0;
};
#endif  // BROADIFY_ENABLE_OPENVINO && defined(_WIN32)

}  // namespace

bool shouldUseOpenVino(const MattingBackendOptions &options,
                       bool openVinoCompiledIn,
                       const std::vector<std::string> &availableDevices) {
  if (!openVinoCompiledIn || options.openVinoDisabled || !options.preferOpenVino) {
    return false;
  }
  if (options.forcedBackend == MattingBackendKind::Modnet) {
    return false;
  }
  if (options.forcedBackend == MattingBackendKind::OpenVinoModnet) {
    return true;
  }
  // Auto: only when an NPU is present. Measured on a UHD 630 (Gen9), FP32
  // OpenVINO-GPU is ~40% slower than DirectML on the same silicon (416ms vs
  // 300ms @512), and on hybrid systems an "Intel GPU present" trigger would
  // steal the keyer from a fast discrete DML adapter (26.5ms on a GTX 1660 Ti
  // in the same laptop). Intel-GPU-only machines therefore stay on DirectML
  // until the INT8 IR proves faster; BROADIFY_MEETING_KEYER_BACKEND can still
  // force OpenVINO for measurements.
  for (const std::string &device : availableDevices) {
    if (hasPrefix(device, "NPU")) {
      return true;
    }
  }
  return false;
}

MattingBackendKind parseForcedMattingBackend(const char *value) {
  if (value == nullptr) {
    return MattingBackendKind::Auto;
  }
  const std::string v(value);
  if (v == "modnet") {
    return MattingBackendKind::Modnet;
  }
  if (v == "openvino_modnet") {
    return MattingBackendKind::OpenVinoModnet;
  }
  return MattingBackendKind::Auto;
}

std::string expandOpenVinoDeviceSelection(const char *value) {
  if (value != nullptr) {
    const std::string v(value);
    if (v == "NPU" || v == "GPU" || v == "CPU") {
      return v;
    }
  }
  // AUTO / unset / invalid -> AUTO with an explicit priority list (OpenVINO
  // "AUTO:<device>,<device>,..." syntax, equivalent to ov::device::priorities).
  return "AUTO:NPU,GPU,CPU";
}

MattingBackendOptions makeMattingBackendOptionsFromEnv(std::string modelsDir) {
  // Read-once env policy, mirroring the other BROADIFY_MEETING_* overrides:
  // - BROADIFY_MEETING_KEYER_BACKEND=modnet|openvino_modnet forces a backend.
  // - BROADIFY_MEETING_KEYER_OPENVINO=0 is the OpenVINO kill switch.
  // - BROADIFY_MEETING_OPENVINO_DEVICE=AUTO|NPU|GPU|CPU picks the device.
  static const MattingBackendKind forcedBackend =
      parseForcedMattingBackend(std::getenv("BROADIFY_MEETING_KEYER_BACKEND"));
  static const bool openVinoDisabled = []() {
    const char *value = std::getenv("BROADIFY_MEETING_KEYER_OPENVINO");
    return value != nullptr && std::string(value) == "0";
  }();
  static const std::string openVinoDevice =
      expandOpenVinoDeviceSelection(std::getenv("BROADIFY_MEETING_OPENVINO_DEVICE"));

  MattingBackendOptions options;
  options.modelsDir = std::move(modelsDir);
  options.forcedBackend = forcedBackend;
  options.openVinoDisabled = openVinoDisabled;
  options.openVinoDevice = openVinoDevice;
  options.loadInApply = true;
  return options;
}

std::unique_ptr<MattingKeyer> createMattingKeyer(const MattingBackendOptions &options) {
  std::unique_ptr<MattingKeyer> modnet =
      std::make_unique<ModnetKeyer>(
          ModnetKeyerOptions{options.modelsDir, options.loadInApply});
#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
  // Device probe: cheap relative to model compile, and the only reliable way
  // to see whether an OpenVINO-capable Intel GPU/NPU exists. A throwing probe
  // (missing runtime DLLs and the like) falls back with one structured line.
  std::vector<std::string> availableDevices;
  const bool probeNeeded = !options.openVinoDisabled && options.preferOpenVino &&
                           options.forcedBackend != MattingBackendKind::Modnet;
  if (probeNeeded) {
    try {
      availableDevices = OpenVinoKeyer::availableDevices();
    } catch (...) {
      std::cout << "{\"type\":\"matting_backend_fallback\","
                   "\"from\":\"openvino_modnet\",\"to\":\"modnet\","
                   "\"reason\":\"openvino_probe_failed\"}" << std::endl;
      return modnet;
    }
  }
  if (shouldUseOpenVino(options, /*openVinoCompiledIn=*/true, availableDevices)) {
    try {
      auto openvino = std::make_unique<OpenVinoKeyer>(
          OpenVinoKeyerOptions{options.modelsDir, options.openVinoDevice});
      std::cout << "{\"type\":\"matting_backend_selected\","
                   "\"backend\":\"openvino_modnet\",\"device\":\""
                << options.openVinoDevice << "\"}" << std::endl;
      return std::make_unique<FallbackMattingKeyer>(std::move(openvino),
                                                    std::move(modnet));
    } catch (...) {
      std::cout << "{\"type\":\"matting_backend_fallback\","
                   "\"from\":\"openvino_modnet\",\"to\":\"modnet\","
                   "\"reason\":\"openvino_construct_failed\"}" << std::endl;
    }
  }
#endif
  return modnet;
}

}  // namespace broadify::meeting
