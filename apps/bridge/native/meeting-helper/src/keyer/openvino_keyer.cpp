// OpenVINO MODNet matting backend. Compiles to an empty translation unit
// unless BROADIFY_ENABLE_OPENVINO is set on Windows (see openvino_keyer.h).
#include "keyer/openvino_keyer.h"

#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)

#include "keyer/matting_common.h"
#include "keyer/model_manifest.h"
#include "util/sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <utility>
#include <vector>

#include <openvino/openvino.hpp>

namespace broadify::meeting {
namespace {

// Initial (and governor-seed) input size. Loading at 512 keeps the
// probeInferenceMs semantics identical to the DirectML path: the governor's
// area-scaling seed heuristic assumes a 512-shape probe.
constexpr uint32_t kInitialInputSize = 512u;

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

bool fileExists(const std::string &path) {
  std::ifstream file(path, std::ios::binary);
  return file.good();
}

uint32_t dimensionOrFallback(size_t value, uint32_t fallback) {
  if (value > 0u && value <= 4096u) {
    return static_cast<uint32_t>(value);
  }
  return fallback;
}

// Compiled-model cache directory. The GPU/NPU plugins compile the model into
// a device blob (multi-second on NPU); ov::cache_dir persists those blobs so
// later helper starts reuse them instead of recompiling. Prefer a stable
// per-user location (%LOCALAPPDATA%), fall back to %TEMP%; empty result
// disables caching (OpenVINO then compiles in memory every start).
std::string compiledModelCacheDir() {
  const char *base = std::getenv("LOCALAPPDATA");
  if (base == nullptr || base[0] == '\0') {
    base = std::getenv("TEMP");
  }
  if (base == nullptr || base[0] == '\0') {
    return "";
  }
  std::error_code errorCode;
  const std::filesystem::path dir =
      std::filesystem::path(base) / "Broadify" / "meeting-helper" / "openvino-cache";
  std::filesystem::create_directories(dir, errorCode);
  if (errorCode) {
    return "";
  }
  return dir.string();
}

// KeyerStatus.provider value from the device OpenVINO actually selected
// (e.g. "NPU", "GPU.0", "CPU" - AUTO resolves to a concrete device).
std::string providerForDevice(const std::string &device) {
  if (device.rfind("NPU", 0) == 0) {
    return "openvino-npu";
  }
  if (device.rfind("GPU", 0) == 0) {
    return "openvino-gpu";
  }
  return "openvino-cpu";
}

// Process-wide ov::Core, created once (mirrors the single Ort::Env pattern).
// The cache dir is set here so every compiled model benefits.
ov::Core &sharedCore() {
  static ov::Core core = []() {
    ov::Core created;
    const std::string cacheDir = compiledModelCacheDir();
    if (!cacheDir.empty()) {
      try {
        created.set_property(ov::cache_dir(cacheDir));
      } catch (...) {
        // Caching is an optimization; a core without it still works.
      }
    }
    return created;
  }();
  return core;
}

}  // namespace

class OpenVinoKeyer::Impl {
 public:
  explicit Impl(OpenVinoKeyerOptions options) : options_(std::move(options)) {
    status_.activeKeyer = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "not_loaded";
  }

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) {
    std::lock_guard<std::mutex> lock(mutex_);
    KeyerResult result;
    if (!ensureLoaded()) {
      result.status = status_;
      return result;
    }
    const auto start = std::chrono::steady_clock::now();
    // backend stays "modnet" (the model family; keyer_chain dispatch and the
    // pipeline's edge-live gate key off it); provider carries "openvino-*".
    status_.backend = "modnet";
    status_.qualityMode = settings.qualityMode;
    status_.metrics = KeyerMetrics{};
    // Size selection mirrors ModnetKeyer's dynamic-size handling: compile a
    // static model per requested size (cached), keep the previous size when a
    // compile fails, and remember the failed size so a stale performance mode
    // cannot retrigger the compile every frame.
    const uint32_t requested = modnetInputSizeForMode(settings.performanceMode);
    uint32_t effective = requested;
    if (requested != currentSize_) {
      if (requested == failedCompileSize_) {
        effective = currentSize_;
      } else if (ensureCompiledForSize(requested, /*warmupRuns=*/1, nullptr)) {
        failedCompileSize_ = 0u;
        currentSize_ = requested;
      } else {
        failedCompileSize_ = requested;
        effective = currentSize_;
      }
    }
    CompiledEntry &entry = compiled_.at(effective);
    status_.provider = entry.provider;

    const auto tensorStart = std::chrono::steady_clock::now();
    buildModnetInputTensor(input, effective, effective, tensor_);
    const auto tensorEnd = std::chrono::steady_clock::now();
    try {
      // Zero-copy input: the ov::Tensor wraps tensor_, which outlives the
      // synchronous infer() below.
      ov::Tensor inputTensor(ov::element::f32,
                             ov::Shape{1u, 3u, effective, effective},
                             tensor_.data());
      entry.request.set_input_tensor(inputTensor);
      const auto runStart = std::chrono::steady_clock::now();
      entry.request.infer();
      const auto runEnd = std::chrono::steady_clock::now();
      ov::Tensor output = entry.request.get_output_tensor();
      const float *mask = output.data<float>();
      if (mask == nullptr) {
        setFallback("invalid_output");
        result.status = status_;
        return result;
      }
      const ov::Shape outputShape = output.get_shape();
      uint32_t maskHeight = effective;
      uint32_t maskWidth = effective;
      if (outputShape.size() >= 2u) {
        maskHeight = dimensionOrFallback(outputShape[outputShape.size() - 2u], effective);
        maskWidth = dimensionOrFallback(outputShape[outputShape.size() - 1u], effective);
      }
      const auto maskStart = std::chrono::steady_clock::now();
      copyModnetAlphaMask(mask, maskWidth, maskHeight, input.timestampNs, result.mask);
      const auto maskEnd = std::chrono::steady_clock::now();
      const auto end = std::chrono::steady_clock::now();
      status_.activeKeyer = "modnet";
      status_.fallbackActive = false;
      status_.fallbackReason.clear();
      status_.inferenceMs = elapsedMs(start, end);
      status_.metrics.tensorMs = elapsedMs(tensorStart, tensorEnd);
      status_.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
      status_.metrics.maskApplyMs = elapsedMs(maskStart, maskEnd);
      status_.metrics.maskWidth = maskWidth;
      status_.metrics.maskHeight = maskHeight;
      result.status = status_;
      return result;
    } catch (...) {
      setFallback("inference_failed");
      result.status = status_;
      return result;
    }
  }

  KeyerStatus status() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
  }

 private:
  struct CompiledEntry {
    ov::CompiledModel model;
    ov::InferRequest request;
    std::string provider;
  };

  bool ensureLoaded() {
    if (loaded_) {
      return true;
    }
    // Same retry backoff as ModnetKeyer: session creation + hashing are
    // expensive, a persistent failure must not stall the program loop.
    const auto now = std::chrono::steady_clock::now();
    if (lastLoadAttemptAt_ != std::chrono::steady_clock::time_point{} &&
        now - lastLoadAttemptAt_ < kModelLoadRetryInterval) {
      return false;
    }
    lastLoadAttemptAt_ = now;

    // Optional INT8 OpenVINO IR (produced offline by
    // scripts/quantize-modnet-openvino.py): preferred over the FP32 ONNX when
    // the manifest declares it AND both IR files verify. Absence or a failed
    // verification silently keeps the ONNX path - the IR is an optimization,
    // not a requirement.
    std::string modelPath;
    const ModelManifestEntry irEntry =
        findModelManifestEntry(options_.modelsDir, "modnet-ov-int8");
    if (!irEntry.file.empty()) {
      const std::string irPath = joinModelPath(options_.modelsDir, irEntry.file);
      if (fileExists(irPath) && verifiedIrEntry(irEntry, irPath)) {
        modelPath = irPath;
      }
    }
    if (modelPath.empty()) {
      const ModelManifestEntry entry =
          findModelManifestEntry(options_.modelsDir, "modnet");
      if (entry.file.empty()) {
        setFallback("manifest_missing");
        return false;
      }
      const std::string onnxPath = joinModelPath(options_.modelsDir, entry.file);
      status_.modelPath = onnxPath;
      if (!fileExists(onnxPath)) {
        setFallback("model_missing");
        return false;
      }
      if (entry.sha256.empty() || entry.sha256 == "release-artifact-required") {
        setFallback("model_hash_missing");
        return false;
      }
      status_.modelHashOk = sha256FileHex(onnxPath) == entry.sha256;
      if (!status_.modelHashOk) {
        setFallback("model_hash_mismatch");
        return false;
      }
      modelPath = onnxPath;
    }
    status_.modelPath = modelPath;

    try {
      // OpenVINO reads both ONNX and IR directly; the model keeps its dynamic
      // dims here and is reshaped statically per compiled size below.
      model_ = sharedCore().read_model(modelPath);
      double probeMedianMs = 0.0;
      if (!ensureCompiledForSize(kInitialInputSize, /*warmupRuns=*/3, &probeMedianMs)) {
        setFallback("session_create_failed");
        return false;
      }
      currentSize_ = kInitialInputSize;
      failedCompileSize_ = 0u;
      status_.probeInferenceMs = probeMedianMs;
      loaded_ = true;
      status_.activeKeyer = "modnet";
      status_.fallbackActive = false;
      status_.fallbackReason.clear();
      return true;
    } catch (...) {
      setFallback("session_create_failed");
      return false;
    }
  }

  // IR entries carry the .xml hash in sha256 and the companion .bin in
  // bin_file/bin_sha256. Both must verify; placeholder hashes do not count.
  bool verifiedIrEntry(const ModelManifestEntry &entry, const std::string &xmlPath) const {
    if (entry.sha256.empty() || entry.sha256 == "release-artifact-required") {
      return false;
    }
    if (sha256FileHex(xmlPath) != entry.sha256) {
      return false;
    }
    if (!entry.binFile.empty()) {
      const std::string binPath = joinModelPath(options_.modelsDir, entry.binFile);
      if (!fileExists(binPath) || entry.binSha256.empty() ||
          sha256FileHex(binPath) != entry.binSha256) {
        return false;
      }
    }
    return true;
  }

  // Compiles (or reuses) the static-shape model for `size` and pays the
  // device compile + first-run cost through warmup runs so visible inferences
  // never hit it (the DirectML lesson). With 3 warmup runs the median is
  // written to `probeMedianMs` (run 1 carries the compile stall, so the
  // median lands on a steady run) - used once to seed the governor.
  bool ensureCompiledForSize(uint32_t size, int warmupRuns, double *probeMedianMs) {
    auto found = compiled_.find(size);
    if (found != compiled_.end()) {
      return true;
    }
    const auto compileStart = std::chrono::steady_clock::now();
    try {
      std::shared_ptr<ov::Model> sized = model_->clone();
      // Static shape per size: MODNet on NPU requires it, the compiled-blob
      // cache keys on it, and it avoids dynamic-shape recompiles at run time.
      sized->reshape(ov::PartialShape{1, 3, static_cast<int64_t>(size),
                                      static_cast<int64_t>(size)});
      ov::CompiledModel compiledModel = sharedCore().compile_model(
          sized, options_.device,
          ov::hint::performance_mode(ov::hint::PerformanceMode::LATENCY));
      CompiledEntry entry;
      entry.model = compiledModel;
      entry.request = compiledModel.create_infer_request();
      entry.provider = resolveProvider(compiledModel);

      std::vector<float> warmupTensor(static_cast<size_t>(3u) * size * size, 0.0f);
      ov::Tensor warmupInput(ov::element::f32, ov::Shape{1u, 3u, size, size},
                             warmupTensor.data());
      std::vector<double> warmupRunMs;
      warmupRunMs.reserve(static_cast<size_t>(std::max(warmupRuns, 1)));
      for (int run = 0; run < std::max(warmupRuns, 1); ++run) {
        entry.request.set_input_tensor(warmupInput);
        const auto runStart = std::chrono::steady_clock::now();
        entry.request.infer();
        warmupRunMs.push_back(elapsedMs(runStart, std::chrono::steady_clock::now()));
      }
      if (probeMedianMs != nullptr && !warmupRunMs.empty()) {
        std::sort(warmupRunMs.begin(), warmupRunMs.end());
        *probeMedianMs = warmupRunMs[warmupRunMs.size() / 2u];
      }
      status_.provider = entry.provider;
      compiled_.emplace(size, std::move(entry));
      std::cout << "{\"type\":\"keyer_session_rebuild\","
                   "\"backend\":\"openvino_modnet\",\"input_size\":" << size
                << ",\"provider\":\"" << status_.provider
                << "\",\"warmup_ms\":"
                << elapsedMs(compileStart, std::chrono::steady_clock::now())
                << "}" << std::endl;
      return true;
    } catch (...) {
      std::cout << "{\"type\":\"keyer_session_rebuild_failed\","
                   "\"backend\":\"openvino_modnet\",\"input_size\":" << size
                << "}" << std::endl;
      return false;
    }
  }

  std::string resolveProvider(ov::CompiledModel &compiledModel) const {
    try {
      const std::vector<std::string> devices =
          compiledModel.get_property(ov::execution_devices);
      if (!devices.empty()) {
        return providerForDevice(devices.front());
      }
    } catch (...) {
      // Fall through to the requested device string.
    }
    return providerForDevice(options_.device);
  }

  void setFallback(const std::string &reason) {
    status_.activeKeyer = "passthrough";
    status_.backend = "modnet";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = reason;
    status_.inferenceMs = -1.0;
  }

  static constexpr std::chrono::seconds kModelLoadRetryInterval{30};

  OpenVinoKeyerOptions options_;
  mutable std::mutex mutex_;
  KeyerStatus status_;
  bool loaded_ = false;
  std::chrono::steady_clock::time_point lastLoadAttemptAt_{};
  uint32_t currentSize_ = kInitialInputSize;
  uint32_t failedCompileSize_ = 0u;
  std::shared_ptr<ov::Model> model_;
  std::map<uint32_t, CompiledEntry> compiled_;
  std::vector<float> tensor_;
};

OpenVinoKeyer::OpenVinoKeyer(OpenVinoKeyerOptions options)
    : impl_(std::make_unique<Impl>(std::move(options))) {}

OpenVinoKeyer::~OpenVinoKeyer() = default;

KeyerResult OpenVinoKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

KeyerStatus OpenVinoKeyer::status() const {
  return impl_->status();
}

std::vector<std::string> OpenVinoKeyer::availableDevices() {
  return sharedCore().get_available_devices();
}

}  // namespace broadify::meeting

#endif  // BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
