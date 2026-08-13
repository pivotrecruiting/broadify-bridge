#pragma once

#include "keyer/keyer.h"

#include <memory>
#include <string>
#include <vector>

namespace broadify::meeting {

// Which matting backend the factory must produce. Auto lets the policy pick
// based on OpenVINO availability and the local Intel GPU/NPU devices.
enum class MattingBackendKind { Auto, Modnet, OpenVinoModnet };

// Inputs for the backend factory. The env-derived fields are filled by
// makeMattingBackendOptionsFromEnv (read-once); tests construct them directly.
struct MattingBackendOptions {
  std::string modelsDir;
  // Programmatic opt-out: false always yields the ONNX Runtime backend.
  bool preferOpenVino = true;
  // BROADIFY_MEETING_KEYER_BACKEND=modnet|openvino_modnet forces a backend
  // (other values, e.g. the macOS vision/coreml switches, map to Auto).
  MattingBackendKind forcedBackend = MattingBackendKind::Auto;
  // BROADIFY_MEETING_KEYER_OPENVINO=0 kill switch: never use OpenVINO, even
  // when forced. Mirrors the other BROADIFY_MEETING_* kill switches.
  bool openVinoDisabled = false;
  // Expanded OpenVINO device selection string (see
  // expandOpenVinoDeviceSelection), e.g. "AUTO:NPU,GPU,CPU" or "GPU".
  std::string openVinoDevice;
};

// Matting keyers additionally expose their status without running a frame:
// the Windows fused path polls status().probeInferenceMs to seed the
// auto-degradation governor before the first visible inference.
class MattingKeyer : public Keyer {
 public:
  virtual KeyerStatus status() const = 0;

  // Warm-handover entry (make-before-break tier step-up): ensure the
  // inference session for the given performance mode ("high_quality" |
  // "balanced" | "performance") is built and shape-warmed WITHOUT producing a
  // mask, so the first visible apply() at that mode does not pay the
  // session-build stall (DirectML: 0.25s idle dGPU up to ~12s iGPU under
  // load). Called from a background warmup thread while the async worker owns
  // the keyer path; implementations must be thread-safe against their other
  // entry points. Default: succeed without doing work — backends whose
  // apply() pays no per-shape build cost need no warmup (a step-up then
  // behaves exactly as before the warm handover existed).
  virtual bool warmupForPerformanceMode(const std::string &performanceMode) {
    (void)performanceMode;
    return true;
  }
};

// Pure selection policy, separated from the factory so the dependency-free
// ctest binary can exercise it with a fake device list. `availableDevices` is
// what ov::Core::get_available_devices() reports (e.g. "CPU", "GPU", "GPU.1",
// "NPU"); on Windows the OpenVINO GPU plugin only enumerates Intel GPUs, so a
// "GPU*"/"NPU*" entry means an OpenVINO-capable Intel device is present.
bool shouldUseOpenVino(const MattingBackendOptions &options,
                       bool openVinoCompiledIn,
                       const std::vector<std::string> &availableDevices);

// Env parsing helpers, exposed for the unit test. Both accept nullptr.
MattingBackendKind parseForcedMattingBackend(const char *value);
// Maps BROADIFY_MEETING_OPENVINO_DEVICE (AUTO|NPU|GPU|CPU) to the OpenVINO
// device selection string. AUTO (and unset/invalid values) expand to
// "AUTO:NPU,GPU,CPU": OpenVINO's AUTO plugin with an explicit priority list,
// so the NPU wins when present, then the Intel GPU, with CPU as the always-
// available last resort.
std::string expandOpenVinoDeviceSelection(const char *value);

// Reads the backend policy env vars once (cached for the process lifetime,
// like the other BROADIFY_MEETING_* overrides) and fills the options.
MattingBackendOptions makeMattingBackendOptionsFromEnv(std::string modelsDir);

// Creates the MODNet matting keyer for this machine. Used at BOTH keyer
// creation sites (KeyerChain's async keyer and the Windows fused keyer in
// frame_pipeline.cpp) so both always run the same backend. Windows with
// OpenVINO compiled in may return the OpenVINO backend (wrapped so that a
// load failure falls back to the ONNX Runtime/DirectML backend at runtime);
// everywhere else this is always the ONNX Runtime ModnetKeyer.
std::unique_ptr<MattingKeyer> createMattingKeyer(const MattingBackendOptions &options);

}  // namespace broadify::meeting
