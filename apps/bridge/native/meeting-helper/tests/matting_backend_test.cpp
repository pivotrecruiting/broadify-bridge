#include "keyer/matting_backend.h"
#include "keyer/modnet_keyer.h"

#include <chrono>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

using broadify::meeting::createMattingKeyer;
using broadify::meeting::AsyncModelLoadRetryGate;
using broadify::meeting::expandOpenVinoDeviceSelection;
using broadify::meeting::MattingBackendKind;
using broadify::meeting::MattingBackendOptions;
using broadify::meeting::parseForcedMattingBackend;
using broadify::meeting::parseModnetPrebuildTierSizes;
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
    // Auto policy: only an NPU triggers OpenVINO. An Intel GPU alone must NOT
    // (measured slower than DirectML in FP32, and on hybrid systems it would
    // steal the keyer from a fast discrete DML adapter).
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                    true, cpuOnly),
                 "auto stays on modnet with CPU-only devices");
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                    true, cpuAndGpu),
                 "auto stays on modnet with an Intel GPU but no NPU");
    ok &= expect(!shouldUseOpenVino(optionsWith(MattingBackendKind::Auto, false),
                                    true, cpuAndEnumeratedGpus),
                 "auto stays on modnet with enumerated GPU.N devices only");
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
    const std::set<uint32_t> all = parseModnetPrebuildTierSizes(nullptr);
    ok &= expect(all.count(512u) == 1u && all.count(320u) == 1u &&
                     all.count(256u) == 1u,
                 "unset PREBUILD_TIERS prebuilds all runtime tiers");
    const std::set<uint32_t> selected =
        parseModnetPrebuildTierSizes("high_quality,performance");
    ok &= expect(selected.count(512u) == 1u && selected.count(256u) == 1u &&
                     selected.count(320u) == 0u,
                 "PREBUILD_TIERS excludes omitted tiers without fallback rebuild");
    const std::set<uint32_t> invalid = parseModnetPrebuildTierSizes("bogus");
    ok &= expect(invalid.count(512u) == 1u && invalid.count(320u) == 1u &&
                     invalid.count(256u) == 1u,
                 "invalid PREBUILD_TIERS falls back to all tiers");
  }

  {
    AsyncModelLoadRetryGate gate;
    using Clock = std::chrono::steady_clock;
    const Clock::time_point t0{std::chrono::seconds(100)};
    broadify::meeting::KeyerStatus status;
    status.fallbackActive = true;
    status.fallbackReason = "model_missing";

    ok &= expect(gate.shouldStartWarmup(status, t0, false, false),
                 "first async load attempt starts for any fallback reason");
    ok &= expect(!gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(29), false, false),
                 "async load retry is throttled for 30 seconds");
    ok &= expect(gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(30), false, false),
                 "async load retry re-arms after 30 seconds");
    ok &= expect(!gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(60), true, false),
                 "busy warmup suppresses retry launch");
    ok &= expect(!gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(60), false, true),
                 "joinable warmup suppresses retry launch until joined");
    status.fallbackActive = false;
    ok &= expect(!gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(60), false, false),
                 "healthy keyer does not start async load retry");
    gate.reset();
    status.fallbackActive = true;
    status.fallbackReason = "session_create_failed";
    ok &= expect(gate.shouldStartWarmup(
                     status, t0 + std::chrono::seconds(1), false, false),
                 "reset clears async load retry backoff");
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

  {
    MattingBackendOptions options = optionsWith(MattingBackendKind::Auto, false);
    options.loadInApply = false;
    std::unique_ptr<broadify::meeting::MattingKeyer> keyer =
        createMattingKeyer(options);
    broadify::meeting::VideoFrame frame;
    frame.width = 4u;
    frame.height = 4u;
    frame.timestampNs = 1u;
    frame.rgba.assign(static_cast<size_t>(frame.width) * frame.height * 4u,
                      128u);
    const broadify::meeting::KeyerResult result =
        keyer->apply(frame, broadify::meeting::KeyerSettings{});
    ok &= expect(result.status.fallbackActive,
                 "async first load reports fallback before warmup");
    ok &= expect(result.status.fallbackReason == "loading",
                 "async first load returns loading without synchronous load");
    ok &= expect(result.mask.alpha.empty(),
                 "async first load does not produce a mask while loading");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "matting_backend_test passed" << std::endl;
  return 0;
}
