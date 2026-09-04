#include "keyer/modnet_keyer.h"

#include "compose/d3d_adapter_select.h"
#include "keyer/matting_common.h"
#include "keyer/model_manifest.h"
#include "keyer/ort_session_options_policy.h"
#include "util/sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <set>
#include <thread>
#include <utility>
#include <vector>

#if BROADIFY_ENABLE_MODNET
#include <onnxruntime_cxx_api.h>
#if defined(__APPLE__)
#include <coreml_provider_factory.h>
#endif
#if defined(_WIN32)
#include <windows.h>
#include <dml_provider_factory.h>
#include <d3d12.h>
#include <directml.h>
#include <wrl/client.h>
#endif
#endif

namespace broadify::meeting {
namespace {

constexpr uint32_t kFallbackInputSize = 512;
constexpr uint32_t kBalancedInputSize = 320;
constexpr uint32_t kPerformanceInputSize = 256;
constexpr uint32_t kMaxCpuInferenceThreads = 4;
// Input normalization and mask readback live in matting_common.cpp: they are
// shared verbatim with the OpenVINO backend so both produce identical tensors
// and masks for the same frame.

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

int inferenceThreadCount() {
  const uint32_t detectedThreads = std::thread::hardware_concurrency();
  if (detectedThreads == 0u) {
    return 2;
  }
  return static_cast<int>(std::clamp(detectedThreads, 2u, kMaxCpuInferenceThreads));
}

std::set<uint32_t> parseModnetPrebuildTierSizesInternal(const char *raw) {
  if (raw == nullptr || raw[0] == '\0') {
    return {kFallbackInputSize, kPerformanceInputSize};
  }
  if (std::string(raw) == "all") {
    return {kFallbackInputSize, kBalancedInputSize, kPerformanceInputSize};
  }
  std::set<uint32_t> sizes;
  const std::string value(raw);
  size_t start = 0u;
  while (start <= value.size()) {
    const size_t comma = value.find(',', start);
    const std::string token =
        value.substr(start, comma == std::string::npos ? std::string::npos
                                                       : comma - start);
    if (token == "active" || token == "high_quality" || token == "512") {
      sizes.insert(kFallbackInputSize);
    } else if (token == "balanced" || token == "320") {
      sizes.insert(kBalancedInputSize);
    } else if (token == "performance" || token == "256") {
      sizes.insert(kPerformanceInputSize);
    }
    if (comma == std::string::npos) {
      break;
    }
    start = comma + 1u;
  }
  if (sizes.empty()) {
    sizes.insert(kFallbackInputSize);
    sizes.insert(kBalancedInputSize);
    sizes.insert(kPerformanceInputSize);
  }
  return sizes;
}

#if BROADIFY_ENABLE_MODNET
std::set<uint32_t> prebuildTierSizesFromEnv() {
  return parseModnetPrebuildTierSizesInternal(
      std::getenv("BROADIFY_MEETING_KEYER_PREBUILD_TIERS"));
}

std::vector<uint32_t> orderedPrebuildTierSizes(const std::set<uint32_t> &sizes) {
  std::vector<uint32_t> ordered;
  if (sizes.count(kFallbackInputSize) != 0u) {
    ordered.push_back(kFallbackInputSize);
  }
  for (const uint32_t size : sizes) {
    if (size != kFallbackInputSize) {
      ordered.push_back(size);
    }
  }
  return ordered;
}

// Self-test provider override, read once: when
// BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER=cpu the CoreML/DirectML execution
// providers are NOT appended, so ORT runs pure CPU. Used by
// scripts/test-meeting-helper.cjs (keyer mode) for hardware-independent CI
// timings; it affects nothing but the EP selection in createSession.
bool selfTestForcesCpuProvider() {
  static const bool forced = []() {
    const char *value = std::getenv("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER");
    return value != nullptr && std::string(value) == "cpu";
  }();
  return forced;
}
#endif

#if BROADIFY_ENABLE_MODNET && defined(_WIN32)
using Microsoft::WRL::ComPtr;
using DmlCreateDeviceFn = HRESULT(WINAPI *)(ID3D12Device *, DML_CREATE_DEVICE_FLAGS,
                                            REFIID, void **);

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

DmlCreateDeviceFn resolveDmlCreateDevice() {
  static DmlCreateDeviceFn fn = []() -> DmlCreateDeviceFn {
    HMODULE module = LoadLibraryW(L"DirectML.dll");
    if (module == nullptr) {
      return nullptr;
    }
    return reinterpret_cast<DmlCreateDeviceFn>(
        GetProcAddress(module, "DMLCreateDevice"));
  }();
  return fn;
}

OrtStatus *appendDirectMlOnSelectedAdapter(Ort::SessionOptions &sessionOptions,
                                           const OrtDmlApi *dmlApi,
                                           std::string *adapterStatus) {
  const D3DAdapterInfo &adapter = directMlD3DAdapter();
  if (!adapter.available || dmlApi == nullptr) {
    return nullptr;
  }

  ComPtr<ID3D12Device> device;
  HRESULT hr = D3D12CreateDevice(adapter.adapter.Get(), D3D_FEATURE_LEVEL_11_0,
                                 IID_PPV_ARGS(&device));
  if (FAILED(hr)) {
    return nullptr;
  }

  D3D12_COMMAND_QUEUE_DESC queueDesc{};
  const DirectMlQueueType dmlQueueType =
      parseDirectMlQueueType(std::getenv("BROADIFY_MEETING_DML_QUEUE"));
  queueDesc.Type = dmlQueueType == DirectMlQueueType::Direct
                       ? D3D12_COMMAND_LIST_TYPE_DIRECT
                       : D3D12_COMMAND_LIST_TYPE_COMPUTE;
  queueDesc.Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
  ComPtr<ID3D12CommandQueue> queue;
  hr = device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue));
  if (FAILED(hr)) {
    return nullptr;
  }

  ComPtr<IDMLDevice> dmlDevice;
  DmlCreateDeviceFn dmlCreateDevice = resolveDmlCreateDevice();
  if (dmlCreateDevice == nullptr) {
    return nullptr;
  }
  hr = dmlCreateDevice(device.Get(), DML_CREATE_DEVICE_FLAG_NONE,
                       IID_PPV_ARGS(&dmlDevice));
  if (FAILED(hr)) {
    return nullptr;
  }
  OrtStatus *status = dmlApi->SessionOptionsAppendExecutionProvider_DML1(
      sessionOptions, dmlDevice.Get(), queue.Get());
  if (status == nullptr && adapterStatus != nullptr) {
    *adapterStatus = d3dAdapterStatusString(adapter);
  }
  return status;
}
#endif

}  // namespace

std::set<uint32_t> parseModnetPrebuildTierSizes(const char *raw) {
  return parseModnetPrebuildTierSizesInternal(raw);
}

class ModnetKeyer::Impl {
 public:
  explicit Impl(ModnetKeyerOptions options) : options_(std::move(options)) {
    status_.activeKeyer = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "not_loaded";
  }

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) {
    // Serializes against warmupForPerformanceMode (warm-handover thread) and
    // status(). Uncontended in steady state: the fused pipeline only ever
    // warms up while the async worker owns the path (this instance is idle).
    std::lock_guard<std::mutex> lock(mutex_);
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
    if (!loaded_ && !options_.loadInApply) {
      if (!loadAttempted_) {
        setFallback("loading");
      }
      result.status = status_;
      return result;
    }
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
      uint32_t effective = sessionRunSize_ != 0u ? sessionRunSize_ : inputWidth_;
      auto sessionIt = tierSessions_.find(requested);
      if (sessionIt != tierSessions_.end()) {
        activeSession_ = sessionIt->second.session.get();
        effective = requested;
        status_.probeInferenceMs = sessionIt->second.probeMs;
      } else if (activeSession_ == nullptr && !tierSessions_.empty()) {
        auto fallbackIt = tierSessions_.begin();
        activeSession_ = fallbackIt->second.session.get();
        effective = fallbackIt->first;
        status_.probeInferenceMs = fallbackIt->second.probeMs;
      }
      if (effective != requested && loggedTierMisses_.insert(requested).second) {
        // Once per requested size: the tier the caller asked for has no
        // prebuilt session, so inference silently continues at `effective`.
        // The governor avoids this via tierBuilt*, but an env pin or stale
        // performance mode can still request a phantom size.
        std::cout << "{\"type\":\"meeting_keyer\",\"event\":\"tier_session_missing\""
                  << ",\"requested\":" << requested
                  << ",\"effective\":" << effective << "}" << std::endl;
      }
      inputWidth_ = effective;
      inputHeight_ = effective;
    }
#endif
    status_.metrics.sessionInputSize = inputWidth_;
    const auto tensorStart = std::chrono::steady_clock::now();
    ModnetLetterboxMapping letterbox;
    buildModnetInputTensor(input, inputWidth_, inputHeight_, tensor_,
                           &letterbox);
    const auto tensorEnd = std::chrono::steady_clock::now();
    std::array<int64_t, 4> inputShape = {1, 3, static_cast<int64_t>(inputHeight_), static_cast<int64_t>(inputWidth_)};
    Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
        memoryInfo, tensor_.data(), tensor_.size(), inputShape.data(), inputShape.size());

    try {
      const auto runStart = std::chrono::steady_clock::now();
      Ort::Session *session = activeSession_;
#if defined(__APPLE__)
      session = session_.get();
#endif
      if (session == nullptr) {
        setFallback("session_not_ready");
        result.status = status_;
        return result;
      }
      auto outputs = session->Run(
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
      copyModnetAlphaMask(mask, maskWidth, maskHeight, letterbox, input.width,
                          input.height, input.timestampNs, result.mask);
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
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
  }

  // Warm-handover entry: verify the requested mode's prebuilt session exists.
  // Session creation happens during load, never from apply().
  bool warmupForPerformanceMode(const std::string &performanceMode) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!ensureLoaded()) {
      return false;
    }
#if BROADIFY_ENABLE_MODNET
#if defined(__APPLE__)
    // macOS freezes the CoreML session shape at load; per-mode rebuilds do
    // not exist there (and the warm handover is Windows-only anyway).
    (void)performanceMode;
    return true;
#else
    if (!modelDynamic_) {
      // Static model: one shape only, already warmed by ensureLoaded().
      return true;
    }
    const uint32_t requested = modnetInputSizeForMode(performanceMode);
    if (tierSessions_.find(requested) != tierSessions_.end()) {
      return true;
    }
    return false;
#endif
#else
    (void)performanceMode;
    return false;
#endif
  }

 private:
  struct TierSession {
#if BROADIFY_ENABLE_MODNET
    std::unique_ptr<Ort::Session> session;
#endif
    double probeMs = 0.0;
  };

  bool ensureLoaded() {
    if (loaded_) {
      return true;
    }
    // Retry with backoff instead of a process-lifetime latch (K-03): a
    // transient failure (model appearing late after an install/update) used to
    // disable the DirectML keyer until the next helper restart. Between
    // attempts apply() returns the fallback status quickly.
    const auto now = std::chrono::steady_clock::now();
    if (lastLoadAttemptAt_ != std::chrono::steady_clock::time_point{} &&
        now - lastLoadAttemptAt_ < kModelLoadRetryInterval) {
      return false;
    }
    lastLoadAttemptAt_ = now;
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
#if defined(__APPLE__)
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
#else
      const std::set<uint32_t> sizes = prebuildTierSizesFromEnv();
      for (const uint32_t size : orderedPrebuildTierSizes(sizes)) {
        inputWidth_ = size;
        inputHeight_ = size;
        std::unique_ptr<Ort::Session> builtSession = createSession();
        if (!builtSession) {
          continue;
        }
        if (inputNames_[0] == nullptr || outputNames_[0] == nullptr) {
          Ort::AllocatorWithDefaultOptions allocator;
          Ort::AllocatedStringPtr inputNameAllocated =
              builtSession->GetInputNameAllocated(0, allocator);
          Ort::AllocatedStringPtr outputNameAllocated =
              builtSession->GetOutputNameAllocated(0, allocator);
          inputName_ = inputNameAllocated.get();
          outputName_ = outputNameAllocated.get();
          inputNames_[0] = inputName_.c_str();
          outputNames_[0] = outputName_.c_str();
        }
        double probeMs = 0.0;
        try {
          std::vector<float> warmupTensor(
              static_cast<size_t>(3u) * size * size, 0.0f);
          std::array<int64_t, 4> warmupShape = {
              1, 3, static_cast<int64_t>(size), static_cast<int64_t>(size)};
          Ort::MemoryInfo memoryInfo =
              Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
          Ort::Value warmupInput = Ort::Value::CreateTensor<float>(
              memoryInfo, warmupTensor.data(), warmupTensor.size(),
              warmupShape.data(), warmupShape.size());
          std::array<double, 3> warmupRunMs = {0.0, 0.0, 0.0};
          for (size_t warmupRun = 0; warmupRun < warmupRunMs.size(); ++warmupRun) {
            const auto runStart = std::chrono::steady_clock::now();
            builtSession->Run(Ort::RunOptions{nullptr}, inputNames_.data(),
                              &warmupInput, 1, outputNames_.data(), 1);
            warmupRunMs[warmupRun] =
                elapsedMs(runStart, std::chrono::steady_clock::now());
          }
          std::sort(warmupRunMs.begin(), warmupRunMs.end());
          probeMs = warmupRunMs[1];
        } catch (...) {
          probeMs = 0.0;
        }
        tierSessions_[size] = TierSession{std::move(builtSession), probeMs};
        if (size == kFallbackInputSize) {
          status_.probeInferenceMs512 = probeMs;
        } else if (size == kBalancedInputSize) {
          status_.probeInferenceMs320 = probeMs;
        } else if (size == kPerformanceInputSize) {
          status_.probeInferenceMs256 = probeMs;
        }
      }
      status_.tierBuilt512 = tierSessions_.count(kFallbackInputSize) != 0u;
      status_.tierBuilt320 = tierSessions_.count(kBalancedInputSize) != 0u;
      status_.tierBuilt256 = tierSessions_.count(kPerformanceInputSize) != 0u;
      if (tierSessions_.empty()) {
        setFallback("model_path_invalid");
        return false;
      }
      auto initialIt = tierSessions_.find(kFallbackInputSize);
      if (initialIt == tierSessions_.end()) {
        initialIt = tierSessions_.begin();
      }
      activeSession_ = initialIt->second.session.get();
      inputWidth_ = inputHeight_ = initialIt->first;
      status_.probeInferenceMs = initialIt->second.probeMs;
      sessionRunSize_ = initialIt->first;
      const auto inputInfo = activeSession_->GetInputTypeInfo(0).GetTensorTypeAndShapeInfo();
#endif
      const std::vector<int64_t> inputShape = inputInfo.GetShape();
      if (inputShape.size() >= 4u) {
        // A dynamic model (dims reported as <= 0) lets us pick the input
        // resolution per frame from the performance mode; a static model is
        // pinned to its declared size.
        modelDynamic_ = inputShape[2] <= 0 || inputShape[3] <= 0;
#if !defined(__APPLE__)
        if (!modelDynamic_) {
          inputHeight_ = dimensionOrFallback(inputShape[2]);
          inputWidth_ = dimensionOrFallback(inputShape[3]);
        }
#else
        // macOS keeps the size chosen in apply() (frozen into the CoreML
        // free-dimension override); don't overwrite it with the model's dims.
#endif
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

#if BROADIFY_ENABLE_MODNET
  // Creates an ORT session for modelPath_ with the platform execution
  // provider (sets status_.provider). Returns nullptr if the model path
  // cannot be represented for the platform API; ORT errors throw.
  std::unique_ptr<Ort::Session> createSession() {
    Ort::SessionOptions sessionOptions;
    // A tier rebuild must not inherit the adapter of a previous session: the
    // provider decision below repopulates it only when DirectML was appended.
    status_.gpuAdapter.clear();
#if !defined(_WIN32)
    sessionOptions.SetIntraOpNumThreads(inferenceThreadCount());
#endif
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
    // Skipped when the self-test forces the CPU provider (see
    // selfTestForcesCpuProvider above); status_.provider then stays "cpu".
    if (!selfTestForcesCpuProvider()) {
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
    }
#elif defined(_WIN32)
    status_.provider = "cpu";
    status_.dmlPath = "cpu";
    status_.dmlQueue = directMlQueueTypeLabel(
        parseDirectMlQueueType(std::getenv("BROADIFY_MEETING_DML_QUEUE")));
    const OrtSessionOptionsPolicy dmlPolicy =
        makeDirectMlSessionOptionsPolicy(inputWidth_, inputHeight_);
    sessionOptions.SetIntraOpNumThreads(inferenceThreadCount());
    // The DirectML execution provider offloads MODNet inference to the GPU,
    // freeing the CPU that otherwise starves the capture, preview and status
    // pipeline. DML requires disabling the memory-pattern optimizer and
    // running the graph sequentially.
    if (dmlPolicy.disableMemPattern) {
      sessionOptions.DisableMemPattern();
    }
    if (dmlPolicy.sequentialExecution) {
      sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
    }
    for (const auto &overrideDim : dmlPolicy.freeDimensionOverrides) {
      sessionOptions.AddFreeDimensionOverrideByName(
          overrideDim.name.c_str(), overrideDim.value);
    }
    // DirectML device selection. By default DML1 uses the same adapter policy
    // as the compositor; BROADIFY_MEETING_GPU_POLICY=split restores the rc.12
    // topology (compositor default adapter, DML HighPerformance) for A/B.
    // DML2 and the legacy device-0 append remain fallbacks.
    // BROADIFY_MEETING_KEYER_DML_LEGACY=1 forces the old device 0.
    // Skipped when the self-test forces the CPU provider (see
    // selfTestForcesCpuProvider above); status_.provider then stays "cpu".
    // The sequential / mem-pattern settings above are harmless for CPU.
    if (!selfTestForcesCpuProvider()) {
      OrtStatus *dmlStatus = nullptr;
      const char *attemptedDmlPath = "cpu";
      const char *dmlLegacyEnv = std::getenv("BROADIFY_MEETING_KEYER_DML_LEGACY");
      const bool forceLegacyDevice0 =
          dmlLegacyEnv != nullptr && dmlLegacyEnv[0] == '1';
      const OrtDmlApi *dmlApi = nullptr;
      if (!forceLegacyDevice0) {
        OrtStatus *apiStatus = Ort::GetApi().GetExecutionProviderApi(
            "DML", ORT_API_VERSION, reinterpret_cast<const void **>(&dmlApi));
        if (apiStatus != nullptr) {
          Ort::GetApi().ReleaseStatus(apiStatus);
          dmlApi = nullptr;
        }
      }
      if (dmlApi != nullptr) {
        dmlStatus = appendDirectMlOnSelectedAdapter(sessionOptions, dmlApi,
                                                    &status_.gpuAdapter);
        if (dmlStatus == nullptr && !status_.gpuAdapter.empty()) {
          status_.provider = "directml";
          status_.dmlPath = "dml1_selected_adapter";
        } else {
          if (dmlStatus != nullptr) {
            Ort::GetApi().ReleaseStatus(dmlStatus);
          }
          OrtDmlDeviceOptions deviceOptions{
              OrtDmlPerformancePreference::HighPerformance, OrtDmlDeviceFilter::Gpu};
          attemptedDmlPath = "dml2_high_performance";
          dmlStatus = dmlApi->SessionOptionsAppendExecutionProvider_DML2(
              sessionOptions, &deviceOptions);
        }
        if (dmlStatus != nullptr) {
          // HighPerformance append failed: fall back to the legacy device 0.
          Ort::GetApi().ReleaseStatus(dmlStatus);
          attemptedDmlPath = "legacy_device0";
          dmlStatus =
              OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0);
        }
      } else {
        attemptedDmlPath = "legacy_device0";
        dmlStatus =
            OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0);
      }
      if (dmlStatus == nullptr) {
        status_.provider = "directml";
        if (status_.dmlPath != std::string("dml1_selected_adapter")) {
          status_.dmlPath = attemptedDmlPath;
        }
        sessionOptions.SetIntraOpNumThreads(dmlPolicy.intraOpThreads);
        for (const auto &entry : dmlPolicy.configEntries) {
          sessionOptions.AddConfigEntry(entry.first.c_str(), entry.second.c_str());
        }
      } else {
        // No DirectML device (no DX12 GPU or driver): fall back to the CPU
        // provider.
        Ort::GetApi().ReleaseStatus(dmlStatus);
      }
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

#endif

  void setFallback(const std::string &reason) {
    status_.activeKeyer = "passthrough";
    status_.backend = "modnet";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = reason;
    status_.inferenceMs = -1.0;
  }

  // Model (re)load attempts are throttled: session creation + hashing are
  // expensive, so a persistent failure must not stall the program loop.
  static constexpr std::chrono::seconds kModelLoadRetryInterval{30};

  ModnetKeyerOptions options_;
  // Guards every member against the warm-handover warmup thread (apply,
  // status and warmupForPerformanceMode all take it for their full body).
  mutable std::mutex mutex_;
  KeyerStatus status_;
  bool loaded_ = false;
  bool loadAttempted_ = false;
  std::chrono::steady_clock::time_point lastLoadAttemptAt_{};
  uint32_t inputWidth_ = kFallbackInputSize;
  uint32_t inputHeight_ = kFallbackInputSize;
  bool modelDynamic_ = false;
  // Shape the current session has run with (0 = no Run yet) and the last
  // size a rebuild failed for (retried only after the requested size changes).
  uint32_t sessionRunSize_ = 0u;
  std::string modelPath_;
#if BROADIFY_ENABLE_MODNET
  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::Session> session_;
  std::map<uint32_t, TierSession> tierSessions_;
  // Requested sizes without a prebuilt session that were already reported via
  // the one-shot tier_session_missing event (guarded by mutex_ like all state).
  std::set<uint32_t> loggedTierMisses_;
  Ort::Session *activeSession_ = nullptr;
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

bool ModnetKeyer::warmupForPerformanceMode(const std::string &performanceMode) {
  return impl_->warmupForPerformanceMode(performanceMode);
}

}  // namespace broadify::meeting
