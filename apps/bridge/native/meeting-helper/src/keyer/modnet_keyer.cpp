#include "keyer/modnet_keyer.h"

#include "keyer/model_manifest.h"
#include "util/sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
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
constexpr float kMean[3] = {0.485f, 0.456f, 0.406f};
constexpr float kStd[3] = {0.229f, 0.224f, 0.225f};

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
    if (modelDynamic_) {
      const uint32_t size = modnetInputSizeForMode(settings.performanceMode);
      inputWidth_ = size;
      inputHeight_ = size;
    }
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
      Ort::SessionOptions sessionOptions;
      sessionOptions.SetIntraOpNumThreads(inferenceThreadCount());
      sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#if defined(__APPLE__)
      status_.provider = "cpu";
      const uint32_t coreMlFlags =
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
      OrtStatus *dmlStatus =
          OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0);
      if (dmlStatus == nullptr) {
        status_.provider = "directml";
      } else {
        // No DirectML device (no DX12 GPU or driver): fall back to the CPU
        // provider. The sequential / mem-pattern settings above are harmless
        // for CPU execution.
        Ort::GetApi().ReleaseStatus(dmlStatus);
      }
#else
      status_.provider = "cpu";
#endif
#if defined(_WIN32)
      const std::wstring ortModelPath = utf8ToWidePath(modelPath);
      if (ortModelPath.empty()) {
        setFallback("model_path_invalid");
        return false;
      }
      session_ = std::make_unique<Ort::Session>(*env_, ortModelPath.c_str(), sessionOptions);
#else
      session_ = std::make_unique<Ort::Session>(*env_, modelPath.c_str(), sessionOptions);
#endif
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
        inputHeight_ = dimensionOrFallback(inputShape[2]);
        inputWidth_ = dimensionOrFallback(inputShape[3]);
      }
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
