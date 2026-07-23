#include "keyer/modnet_keyer.h"

#include "keyer/model_manifest.h"
#include "util/sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <numeric>
#include <thread>
#include <utility>

#if BROADIFY_ENABLE_MODNET
#include <onnxruntime_cxx_api.h>
#if defined(__APPLE__)
#include <coreml_provider_factory.h>
#endif
#if defined(_WIN32)
#include <windows.h>
#include <dml_provider_factory.h>
#endif
#endif

namespace broadify::meeting {
namespace {

constexpr uint32_t kFallbackInputSize = 512;
constexpr uint32_t kMaxCpuInferenceThreads = 4;
// MODNet normalizes input as (value/255 - 0.5)/0.5 -> range [-1,1] (mean/std
// 0.5 per channel), NOT ImageNet mean/std. Using ImageNet stats here silently
// degrades the matte. Channel order is RGB (our frames are already RGBA), NCHW.
constexpr float kMean[3] = {0.5f, 0.5f, 0.5f};
constexpr float kStd[3] = {0.5f, 0.5f, 0.5f};

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

bool fileExists(const std::string &path) {
  std::ifstream file(path, std::ios::binary);
  return file.good();
}

uint32_t dimensionOrFallback(int64_t value) {
  if (value > 0 && value <= 4096) {
    return static_cast<uint32_t>(value);
  }
  return kFallbackInputSize;
}

// Square MODNet input resolution derived from the performance mode. The model
// accepts dynamic input dimensions, so lowering this is the primary lever for
// inference latency on weak GPUs/CPUs. Masks below 400px are edge-refined by
// the joint-bilateral upsampler in the frame pipeline, which recovers detail.
constexpr uint32_t kModnetInputHighQuality = 512u;
constexpr uint32_t kModnetInputBalanced = 320u;
constexpr uint32_t kModnetInputPerformance = 256u;

uint32_t modnetInputSizeForMode(const std::string &performanceMode) {
  if (performanceMode == "performance") {
    return kModnetInputPerformance;
  }
  if (performanceMode == "balanced") {
    return kModnetInputBalanced;
  }
  return kModnetInputHighQuality;  // high_quality / unknown -> full resolution
}

size_t clampIndex(size_t value, size_t upperExclusive) {
  if (upperExclusive == 0u) {
    return 0u;
  }
  return std::min(value, upperExclusive - 1u);
}

int inferenceThreadCount() {
  const uint32_t detectedThreads = std::thread::hardware_concurrency();
  if (detectedThreads == 0u) {
    return 2;
  }
  return static_cast<int>(std::clamp(detectedThreads, 2u, kMaxCpuInferenceThreads));
}

#if BROADIFY_ENABLE_MODNET && defined(_WIN32)
std::wstring utf8ToWidePath(const std::string &path) {
  if (path.empty()) {
    return std::wstring();
  }

  const int requiredLength =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, nullptr, 0);
  if (requiredLength <= 0) {
    return std::wstring();
  }

  std::wstring widePath(static_cast<size_t>(requiredLength), L'\0');
  const int convertedLength =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, widePath.data(), requiredLength);
  if (convertedLength <= 0) {
    return std::wstring();
  }

  if (!widePath.empty() && widePath.back() == L'\0') {
    widePath.pop_back();
  }
  return widePath;
}
#endif

}  // namespace

class ModnetKeyer::Impl {
 public:
  explicit Impl(ModnetKeyerOptions options) : options_(std::move(options)) {
    status_.activeKeyer = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "not_loaded";
  }

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) {
    KeyerResult result;
#if defined(__APPLE__)
    // Choose the CoreML input size from the performance mode BEFORE the session
    // is created: the free-dimension override freezes the shape for the session's
    // life. high_quality=512 (sharpest), balanced=320 / performance=256 (lower
    // latency: smaller input -> faster inference -> fresher mask on motion).
    // Changing the mode takes effect on the next engine start.
    if (!loaded_) {
      inputWidth_ = inputHeight_ = modnetInputSizeForMode(settings.performanceMode);
    }
#endif
    if (!ensureLoaded()) {
      result.status = status_;
      return result;
    }
#if BROADIFY_ENABLE_MODNET
    const auto start = std::chrono::steady_clock::now();
    status_.backend = "modnet";
    status_.qualityMode = settings.qualityMode;
    status_.metrics = KeyerMetrics{};
    // Derive the model input resolution from the performance mode. The model is
    // dynamic, so a smaller square input directly cuts inference cost; the
    // frame pipeline's joint-bilateral upsampler refines masks below 400px.
    //
    // The DirectML EP compiles its kernels for the shape of the first Run
    // only; feeding a different shape afterwards recompiles on EVERY Run
    // (~145ms -> ~2.4s per inference at 320 -> 256, measured 2026-07-07,
    // steady over minutes). A resolution change therefore needs a fresh
    // session plus one warmup Run at the new shape. If the rebuild fails,
    // keying continues at the previous resolution instead of degrading into
    // the per-Run recompile trap; the failed size is remembered so a stale
    // performance mode cannot retrigger the rebuild every frame.
#if defined(__APPLE__)
    // macOS pins MODNet to the size the CoreML session was frozen to (see the
    // free-dimension override in createSession); switching sizes per frame would
    // break the fixed-shape MLProgram graph. inputWidth_/inputHeight_ keep their
    // loaded value (512).
    (void)settings;
#else
    if (modelDynamic_) {
      const uint32_t requested = modnetInputSizeForMode(settings.performanceMode);
      uint32_t effective = requested;
      if (sessionRunSize_ != 0u && requested != sessionRunSize_) {
        if (requested == failedRebuildSize_) {
          effective = sessionRunSize_;
        } else if (rebuildSessionForSize(requested)) {
          failedRebuildSize_ = 0u;
        } else {
          failedRebuildSize_ = requested;
          effective = sessionRunSize_;
        }
      }
      inputWidth_ = effective;
      inputHeight_ = effective;
    }
#endif
    const auto tensorStart = std::chrono::steady_clock::now();
    makeInputTensor(input, tensor_);
    const auto tensorEnd = std::chrono::steady_clock::now();
    std::array<int64_t, 4> inputShape = {1, 3, static_cast<int64_t>(inputHeight_), static_cast<int64_t>(inputWidth_)};
    Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
        memoryInfo, tensor_.data(), tensor_.size(), inputShape.data(), inputShape.size());

    try {
      const auto runStart = std::chrono::steady_clock::now();
      auto outputs = session_->Run(
          Ort::RunOptions{nullptr},
          inputNames_.data(),
          &inputTensor,
          1,
          outputNames_.data(),
          1);
      const auto runEnd = std::chrono::steady_clock::now();
      if (outputs.empty() || !outputs[0].IsTensor()) {
        setFallback("invalid_output");
        result.status = status_;
        return result;
      }
      const float *mask = outputs[0].GetTensorData<float>();
      const auto outputInfo = outputs[0].GetTensorTypeAndShapeInfo();
      const std::vector<int64_t> outputShape = outputInfo.GetShape();
      uint32_t maskHeight = inputHeight_;
      uint32_t maskWidth = inputWidth_;
      if (outputShape.size() >= 2u) {
        maskHeight = dimensionOrFallback(outputShape[outputShape.size() - 2u]);
        maskWidth = dimensionOrFallback(outputShape[outputShape.size() - 1u]);
      }
      const auto maskStart = std::chrono::steady_clock::now();
      copyAlphaMask(mask, maskWidth, maskHeight, input.timestampNs, result.mask);
      const auto maskEnd = std::chrono::steady_clock::now();
      const auto end = std::chrono::steady_clock::now();
      sessionRunSize_ = inputWidth_;
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
#else
    setFallback("onnxruntime_disabled");
    result.status = status_;
    return result;
#endif
  }

  KeyerStatus status() const {
    return status_;
  }

 private:
  bool ensureLoaded() {
    if (loaded_) {
      return true;
    }
    if (loadAttempted_) {
      return false;
    }
    loadAttempted_ = true;

    const ModelManifestEntry entry = findModelManifestEntry(options_.modelsDir, "modnet");
    if (entry.file.empty()) {
      setFallback("manifest_missing");
      return false;
    }
    const std::string modelPath = joinModelPath(options_.modelsDir, entry.file);
    status_.modelPath = modelPath;
    if (!fileExists(modelPath)) {
      setFallback("model_missing");
      return false;
    }
    if (entry.sha256.empty() || entry.sha256 == "release-artifact-required") {
      setFallback("model_hash_missing");
      return false;
    }
    const std::string actualHash = sha256FileHex(modelPath);
    status_.modelHashOk = actualHash == entry.sha256;
    if (!status_.modelHashOk) {
      setFallback("model_hash_mismatch");
      return false;
    }
#if BROADIFY_ENABLE_MODNET
    try {
      env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "broadify-meeting-helper");
      modelPath_ = modelPath;
      session_ = createSession();
      if (!session_) {
        setFallback("model_path_invalid");
        return false;
      }
      Ort::AllocatorWithDefaultOptions allocator;
      Ort::AllocatedStringPtr inputNameAllocated = session_->GetInputNameAllocated(0, allocator);
      Ort::AllocatedStringPtr outputNameAllocated = session_->GetOutputNameAllocated(0, allocator);
      inputName_ = inputNameAllocated.get();
      outputName_ = outputNameAllocated.get();
      inputNames_[0] = inputName_.c_str();
      outputNames_[0] = outputName_.c_str();
      const auto inputInfo = session_->GetInputTypeInfo(0).GetTensorTypeAndShapeInfo();
      const std::vector<int64_t> inputShape = inputInfo.GetShape();
      if (inputShape.size() >= 4u) {
        // A dynamic model (dims reported as <= 0) lets us pick the input
        // resolution per frame from the performance mode; a static model is
        // pinned to its declared size.
        modelDynamic_ = inputShape[2] <= 0 || inputShape[3] <= 0;
#if !defined(__APPLE__)
        inputHeight_ = dimensionOrFallback(inputShape[2]);
        inputWidth_ = dimensionOrFallback(inputShape[3]);
#else
        // macOS keeps the size chosen in apply() (frozen into the CoreML
        // free-dimension override); don't overwrite it with the model's dims.
#endif
      }
#if defined(_WIN32)
      // Warm up the freshly created session so the FIRST visible inference does
      // not pay the DirectML shape-compile stall (documented above, ~145ms up
      // to ~2.4s) -- that stall is what makes the keyer flicker/jump for the
      // first seconds after the engine starts. A single zero-input Run compiles
      // the kernels now. Non-fatal: on failure the first real frame just pays it.
      if (inputWidth_ > 0u && inputHeight_ > 0u) {
        try {
          std::vector<float> warmupTensor(
              static_cast<size_t>(3u) * inputWidth_ * inputHeight_, 0.0f);
          std::array<int64_t, 4> warmupShape = {
              1, 3, static_cast<int64_t>(inputHeight_),
              static_cast<int64_t>(inputWidth_)};
          Ort::MemoryInfo memoryInfo =
              Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
          Ort::Value warmupInput = Ort::Value::CreateTensor<float>(
              memoryInfo, warmupTensor.data(), warmupTensor.size(),
              warmupShape.data(), warmupShape.size());
          session_->Run(Ort::RunOptions{nullptr}, inputNames_.data(),
                        &warmupInput, 1, outputNames_.data(), 1);
          sessionRunSize_ = inputWidth_;
        } catch (...) {
          // Warmup is best-effort; ignore failures.
        }
      }
#endif
      loaded_ = true;
      status_.activeKeyer = "modnet";
      status_.fallbackActive = false;
      status_.fallbackReason.clear();
      return true;
    } catch (...) {
      setFallback("session_create_failed");
      return false;
    }
#else
    setFallback("onnxruntime_disabled");
    return false;
#endif
  }

#if BROADIFY_ENABLE_MODNET
  // Creates an ORT session for modelPath_ with the platform execution
  // provider (sets status_.provider). Returns nullptr if the model path
  // cannot be represented for the platform API; ORT errors throw.
  std::unique_ptr<Ort::Session> createSession() {
    Ort::SessionOptions sessionOptions;
    sessionOptions.SetIntraOpNumThreads(inferenceThreadCount());
    sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#if defined(__APPLE__)
    status_.provider = "cpu";
    // Freeze the model's dynamic input dims (batch/height/width) to the fixed
    // size we run at. Without this CoreML rejects the whole dynamic graph and
    // MODNet runs on CPU (~150ms/frame); with a static shape plus the MLProgram
    // backend it compiles for ANE/GPU (~30ms at 512 on M1 Pro). The default
    // NeuralNetwork backend still CPU-falls-back MODNet's Resize/Pad ops, so
    // COREML_FLAG_CREATE_MLPROGRAM is required. The model file itself is left
    // dynamic (Windows/DirectML picks its own sizes).
    sessionOptions.AddFreeDimensionOverrideByName("batch_size", 1);
    sessionOptions.AddFreeDimensionOverrideByName(
        "height", static_cast<int64_t>(inputHeight_));
    sessionOptions.AddFreeDimensionOverrideByName(
        "width", static_cast<int64_t>(inputWidth_));
    const uint32_t coreMlFlags =
        COREML_FLAG_CREATE_MLPROGRAM |
        COREML_FLAG_ENABLE_ON_SUBGRAPH |
        COREML_FLAG_ONLY_ALLOW_STATIC_INPUT_SHAPES;
    OrtStatus *coreMlStatus = OrtSessionOptionsAppendExecutionProvider_CoreML(sessionOptions, coreMlFlags);
    if (coreMlStatus == nullptr) {
      status_.provider = "coreml";
    } else {
      Ort::GetApi().ReleaseStatus(coreMlStatus);
    }
#elif defined(_WIN32)
    status_.provider = "cpu";
    // The DirectML execution provider offloads MODNet inference to the GPU,
    // freeing the CPU that otherwise starves the capture, preview and status
    // pipeline. DML requires disabling the memory-pattern optimizer and
    // running the graph sequentially.
    sessionOptions.DisableMemPattern();
    sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
    // DirectML device selection. Device 0 (the legacy default) is on hybrid
    // laptops usually the weak Intel iGPU rather than the discrete NVIDIA/AMD
    // GPU -> slow inference, stale masks, keyer flicker. Prefer the DML2 API,
    // which asks DXGI for the HighPerformance (discrete) GPU adapter, and fall
    // back to the legacy device-0 append (then CPU) if DML2 or a GPU is
    // unavailable. BROADIFY_MEETING_KEYER_DML_LEGACY=1 forces the old device 0.
    const char *selfTestProvider =
        std::getenv("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER");
    const bool forceCpuProvider =
        options_.keyerSelfTest && selfTestProvider != nullptr &&
        std::strcmp(selfTestProvider, "cpu") == 0;
    OrtStatus *dmlStatus = nullptr;
    const char *dmlLegacyEnv = std::getenv("BROADIFY_MEETING_KEYER_DML_LEGACY");
    const bool forceLegacyDevice0 =
        dmlLegacyEnv != nullptr && dmlLegacyEnv[0] == '1';
    const OrtDmlApi *dmlApi = nullptr;
    if (!forceCpuProvider && !forceLegacyDevice0) {
      OrtStatus *apiStatus = Ort::GetApi().GetExecutionProviderApi(
          "DML", ORT_API_VERSION, reinterpret_cast<const void **>(&dmlApi));
      if (apiStatus != nullptr) {
        Ort::GetApi().ReleaseStatus(apiStatus);
        dmlApi = nullptr;
      }
    }
    if (forceCpuProvider) {
      dmlStatus = nullptr;
    } else if (dmlApi != nullptr) {
      OrtDmlDeviceOptions deviceOptions{
          OrtDmlPerformancePreference::HighPerformance, OrtDmlDeviceFilter::Gpu};
      dmlStatus = dmlApi->SessionOptionsAppendExecutionProvider_DML2(
          sessionOptions, &deviceOptions);
      if (dmlStatus != nullptr) {
        // HighPerformance append failed: fall back to the legacy device 0.
        Ort::GetApi().ReleaseStatus(dmlStatus);
        dmlStatus =
            OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0);
      }
    } else {
      dmlStatus =
          OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0);
    }
    if (!forceCpuProvider && dmlStatus == nullptr) {
      status_.provider = "directml";
    } else if (dmlStatus != nullptr) {
      // No DirectML device (no DX12 GPU or driver): fall back to the CPU
      // provider. The sequential / mem-pattern settings above are harmless
      // for CPU execution.
      Ort::GetApi().ReleaseStatus(dmlStatus);
    }
#else
    status_.provider = "cpu";
#endif
#if defined(_WIN32)
    const std::wstring ortModelPath = utf8ToWidePath(modelPath_);
    if (ortModelPath.empty()) {
      return nullptr;
    }
    return std::make_unique<Ort::Session>(*env_, ortModelPath.c_str(), sessionOptions);
#else
    return std::make_unique<Ort::Session>(*env_, modelPath_.c_str(), sessionOptions);
#endif
  }

  // Replaces the session and pays the execution provider's shape-compile cost
  // for `size` through a warmup Run, so visible inferences never hit it. The
  // old session stays in place when anything fails.
  bool rebuildSessionForSize(uint32_t size) {
    const auto rebuildStart = std::chrono::steady_clock::now();
    try {
      std::unique_ptr<Ort::Session> newSession = createSession();
      if (!newSession) {
        return false;
      }
      std::vector<float> warmupTensor(static_cast<size_t>(3u) * size * size, 0.0f);
      std::array<int64_t, 4> warmupShape = {1, 3, static_cast<int64_t>(size), static_cast<int64_t>(size)};
      Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
      Ort::Value warmupInput = Ort::Value::CreateTensor<float>(
          memoryInfo, warmupTensor.data(), warmupTensor.size(), warmupShape.data(), warmupShape.size());
      newSession->Run(
          Ort::RunOptions{nullptr}, inputNames_.data(), &warmupInput, 1, outputNames_.data(), 1);
      session_ = std::move(newSession);
      sessionRunSize_ = size;
      std::cout << "{\"type\":\"keyer_session_rebuild\",\"input_size\":" << size
                << ",\"warmup_ms\":" << elapsedMs(rebuildStart, std::chrono::steady_clock::now())
                << "}" << std::endl;
      return true;
    } catch (...) {
      std::cout << "{\"type\":\"keyer_session_rebuild_failed\",\"input_size\":" << size
                << "}" << std::endl;
      return false;
    }
  }
#endif

  void makeInputTensor(const VideoFrame &input, std::vector<float> &tensor) const {
    tensor.resize(static_cast<size_t>(3u) * inputWidth_ * inputHeight_);
    const size_t channelSize = static_cast<size_t>(inputWidth_) * inputHeight_;
    for (uint32_t y = 0; y < inputHeight_; ++y) {
      const uint32_t sy = static_cast<uint32_t>((static_cast<uint64_t>(y) * input.height) / inputHeight_);
      for (uint32_t x = 0; x < inputWidth_; ++x) {
        const uint32_t sx = static_cast<uint32_t>((static_cast<uint64_t>(x) * input.width) / inputWidth_);
        const size_t srcOffset = (static_cast<size_t>(sy) * input.width + sx) * 4u;
        const size_t dstOffset = static_cast<size_t>(y) * inputWidth_ + x;
        const float r = static_cast<float>(input.rgba[srcOffset + 0u]) / 255.0f;
        const float g = static_cast<float>(input.rgba[srcOffset + 1u]) / 255.0f;
        const float b = static_cast<float>(input.rgba[srcOffset + 2u]) / 255.0f;
        tensor[dstOffset] = (r - kMean[0]) / kStd[0];
        tensor[channelSize + dstOffset] = (g - kMean[1]) / kStd[1];
        tensor[channelSize * 2u + dstOffset] = (b - kMean[2]) / kStd[2];
      }
    }
  }

  void copyAlphaMask(const float *mask, uint32_t maskWidth, uint32_t maskHeight, uint64_t timestampNs, AlphaMask &outputMask) const {
    if (mask == nullptr || maskWidth == 0u || maskHeight == 0u) {
      return;
    }
    outputMask.width = maskWidth;
    outputMask.height = maskHeight;
    outputMask.timestampNs = timestampNs;
    outputMask.alpha.assign(static_cast<size_t>(maskWidth) * maskHeight, 0u);
    for (uint32_t y = 0; y < maskHeight; ++y) {
      for (uint32_t x = 0; x < maskWidth; ++x) {
        const size_t offset = static_cast<size_t>(y) * maskWidth + x;
        const float alpha = std::clamp(mask[offset], 0.0f, 1.0f);
        outputMask.alpha[offset] = static_cast<uint8_t>(std::round(alpha * 255.0f));
      }
    }
  }

  void setFallback(const std::string &reason) {
    status_.activeKeyer = "passthrough";
    status_.backend = "modnet";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = reason;
    status_.inferenceMs = -1.0;
  }

  ModnetKeyerOptions options_;
  KeyerStatus status_;
  bool loaded_ = false;
  bool loadAttempted_ = false;
  uint32_t inputWidth_ = kFallbackInputSize;
  uint32_t inputHeight_ = kFallbackInputSize;
  bool modelDynamic_ = false;
  // Shape the current session has run with (0 = no Run yet) and the last
  // size a rebuild failed for (retried only after the requested size changes).
  uint32_t sessionRunSize_ = 0u;
  uint32_t failedRebuildSize_ = 0u;
  std::string modelPath_;
#if BROADIFY_ENABLE_MODNET
  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::Session> session_;
  std::string inputName_;
  std::string outputName_;
  std::array<const char *, 1> inputNames_ = {nullptr};
  std::array<const char *, 1> outputNames_ = {nullptr};
  std::vector<float> tensor_;
#endif
};

ModnetKeyer::ModnetKeyer(ModnetKeyerOptions options) : impl_(std::make_unique<Impl>(std::move(options))) {}

ModnetKeyer::~ModnetKeyer() = default;

KeyerResult ModnetKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

KeyerStatus ModnetKeyer::status() const {
  return impl_->status();
}

}  // namespace broadify::meeting
