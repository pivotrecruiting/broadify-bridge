#include "keyer/matting_backend.h"

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using broadify::meeting::createMattingKeyer;
using broadify::meeting::expandOpenVinoDeviceSelection;
using broadify::meeting::MattingBackendKind;
using broadify::meeting::MattingBackendOptions;
using broadify::meeting::parseForcedMattingBackend;
using broadify::meeting::shouldUseOpenVino;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "matting_backend_test failed: " << what << std::endl;
  }
  return condition;
}

MattingBackendOptions optionsWith(MattingBackendKind forced, bool disabled) {
  MattingBackendOptions options;
  options.modelsDir = "";
  options.forcedBackend = forced;
  options.openVinoDisabled = disabled;
  options.openVinoDevice = expandOpenVinoDeviceSelection(nullptr);
  return options;
}

}  // namespace

int main() {
  bool ok = true;

  const std::vector<std::string> noDevices;
  const std::vector<std::string> cpuOnly = {"CPU"};
  const std::vector<std::string> cpuAndGpu = {"CPU", "GPU"};
  const std::vector<std::string> cpuAndEnumeratedGpus = {"CPU", "GPU.0", "GPU.1"};
  const std::vector<std::string> cpuAndNpu = {"CPU", "NPU"};

  {
    // Not compiled in -> never OpenVINO, regardless of devices or force.
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                    false, cpuAndGpu),
                 "no OpenVINO when not compiled in");
    ok &= expect(!shouldUseOpenVino(
                     optionsWith(MattingBackendKind::OpenVinoModnet, false),
                     false, cpuAndNpu),
                 "force cannot override a build without OpenVINO");
  }

  {
    // Kill switch beats everything, including the force.
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, true),
                                    true, cpuAndGpu),
                 "kill switch disables auto selection");
    ok &= expect(!shouldUseOpenVino(
                     optionsWith(MattingBackendKind::OpenVinoModnet, true),
                     true, cpuAndNpu),
                 "kill switch disables the forced backend");
  }

  {
    // Forced backends.
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Modnet, false),
                                    true, cpuAndNpu),
                 "forced modnet wins over available devices");
    ok &= expect(shouldUseOpenVino(
                     optionsWith(MattingBackendKind::OpenVinoModnet, false),
                     true, noDevices),
                 "forced openvino wins over an empty device probe");
  }

  {
    // Auto policy: an Intel GPU or NPU must be present.
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                    true, cpuOnly),
                 "auto stays on modnet with CPU-only devices");
    ok &= expect(shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                   true, cpuAndGpu),
                 "auto selects OpenVINO with a GPU device");
    ok &= expect(shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                   true, cpuAndEnumeratedGpus),
                 "auto selects OpenVINO with enumerated GPU.N devices");
    ok &= expect(shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                   true, cpuAndNpu),
                 "auto selects OpenVINO with an NPU device");
  }

  {
    // Programmatic opt-out.
    MattingBackendOptions options = optionsWith(MattingBackendKind::Auto, false);
    options.preferOpenVino = false;
    ok &= expect(!shouldUseOpenVino(options, true, cpuAndNpu),
                 "preferOpenVino=false keeps modnet");
  }

  {
    // Env parsing: forced backend.
    ok &= expect(parseForcedMattingBackend(nullptr) == MattingBackendKind::Auto,
                 "unset backend env parses to Auto");
    ok &= expect(parseForcedMattingBackend("modnet") == MattingBackendKind::Modnet,
                 "modnet parses to Modnet");
    ok &= expect(parseForcedMattingBackend("openvino_modnet") ==
                     MattingBackendKind::OpenVinoModnet,
                 "openvino_modnet parses to OpenVinoModnet");
    ok &= expect(parseForcedMattingBackend("vision_person_segmentation") ==
                     MattingBackendKind::Auto,
                 "macOS backend values parse to Auto");
    ok &= expect(parseForcedMattingBackend("") == MattingBackendKind::Auto,
                 "empty backend env parses to Auto");
  }

  {
    // Env parsing: device selection expansion.
    ok &= expect(expandOpenVinoDeviceSelection(nullptr) == "AUTO:NPU,GPU,CPU",
                 "unset device expands to the AUTO priority list");
    ok &= expect(expandOpenVinoDeviceSelection("AUTO") == "AUTO:NPU,GPU,CPU",
                 "AUTO expands to the AUTO priority list");
    ok &= expect(expandOpenVinoDeviceSelection("NPU") == "NPU", "NPU stays NPU");
    ok &= expect(expandOpenVinoDeviceSelection("GPU") == "GPU", "GPU stays GPU");
    ok &= expect(expandOpenVinoDeviceSelection("CPU") == "CPU", "CPU stays CPU");
    ok &= expect(expandOpenVinoDeviceSelection("bogus") == "AUTO:NPU,GPU,CPU",
                 "invalid device values expand to the AUTO priority list");
  }

  {
    // Factory wiring: without OpenVINO compiled in (this test binary) the
    // factory must return a working ModnetKeyer-backed instance whose apply()
    // reports the manifest-missing fallback for an empty models dir.
    MattingBackendOptions options = optionsWith(MattingBackendKind::Auto, false);
    std::unique_ptr<broadify::meeting::MattingKeyer> keyer = createMattingKeyer(options);
    ok &= expect(keyer != nullptr, "factory returns a keyer");
    broadify::meeting::VideoFrame frame;
    frame.width = 4u;
    frame.height = 4u;
    frame.timestampNs = 1u;
    frame.rgba.assign(static_cast<size_t>(frame.width) * frame.height * 4u, 128u);
    const broadify::meeting::KeyerResult result =
        keyer->apply(frame, broadify::meeting::KeyerSettings{});
    ok &= expect(result.status.fallbackActive,
                 "empty models dir keeps the fallback active");
    ok &= expect(result.status.fallbackReason == "manifest_missing",
                 "empty models dir reports manifest_missing");
    ok &= expect(result.mask.alpha.empty(), "fallback result carries no mask");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "matting_backend_test passed" << std::endl;
  return 0;
}
