#include "keyer/selfie_keyer.h"

#include "compose/d3d_adapter_select.h"
#include "keyer/matting_common.h"
#include "keyer/model_manifest.h"
#include "keyer/ort_session_options_policy.h"
#include "util/sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <mutex>
#include <utility>
#include <vector>

#if BROADIFY_ENABLE_MODNET
#include <onnxruntime_cxx_api.h>
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

constexpr uint32_t kSelfieInputWidth = 256u;
constexpr uint32_t kSelfieInputHeight = 144u;

bool fileExists(const std::string &path) {
  std::ifstream file(path, std::ios::binary);
  return file.good();
}

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

float sigmoid(float value) {
  return 1.0f / (1.0f + std::exp(-value));
}

#if BROADIFY_ENABLE_MODNET && defined(_WIN32)
using Microsoft::WRL::ComPtr;
using DmlCreateDeviceFn = HRESULT(WINAPI *)(ID3D12Device *, DML_CREATE_DEVICE_FLAGS,
                                            REFIID, void **);

std::wstring utf8ToWidePath(const std::string &path) {
  if (path.empty()) {
    return std::wstring();
  }
  const int requiredLength =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1,
                          nullptr, 0);
  if (requiredLength <= 0) {
    return std::wstring();
  }
  std::wstring widePath(static_cast<size_t>(requiredLength), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1,
                          widePath.data(), requiredLength) <= 0) {
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
    return module == nullptr
               ? nullptr
               : reinterpret_cast<DmlCreateDeviceFn>(
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
  if (FAILED(D3D12CreateDevice(adapter.adapter.Get(), D3D_FEATURE_LEVEL_11_0,
                               IID_PPV_ARGS(&device)))) {
    return nullptr;
  }
  D3D12_COMMAND_QUEUE_DESC queueDesc{};
  queueDesc.Type = D3D12_COMMAND_LIST_TYPE_COMPUTE;
  ComPtr<ID3D12CommandQueue> queue;
  if (FAILED(device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue)))) {
    return nullptr;
  }
  ComPtr<IDMLDevice> dmlDevice;
  DmlCreateDeviceFn dmlCreateDevice = resolveDmlCreateDevice();
  if (dmlCreateDevice == nullptr ||
      FAILED(dmlCreateDevice(device.Get(), DML_CREATE_DEVICE_FLAG_NONE,
                             IID_PPV_ARGS(&dmlDevice)))) {
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

class SelfieKeyer::Impl {
 public:
  explicit Impl(SelfieKeyerOptions options) : options_(std::move(options)) {
    status_.activeKeyer = "passthrough";
    status_.backend = "selfie_landscape";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = "not_loaded";
  }

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &) {
    std::lock_guard<std::mutex> lock(mutex_);
    KeyerResult result;
    if (!ensureLoaded()) {
      result.status = status_;
      return result;
    }
#if BROADIFY_ENABLE_MODNET
    const auto start = std::chrono::steady_clock::now();
    const auto tensorStart = std::chrono::steady_clock::now();
    ModnetLetterboxMapping mapping;
    buildInputTensor(input, tensor_, &mapping);
    const auto tensorEnd = std::chrono::steady_clock::now();
    std::array<int64_t, 4> inputShape = {
        1, static_cast<int64_t>(kSelfieInputHeight),
        static_cast<int64_t>(kSelfieInputWidth), 3};
    Ort::MemoryInfo memoryInfo =
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
        memoryInfo, tensor_.data(), tensor_.size(), inputShape.data(),
        inputShape.size());
    try {
      const auto runStart = std::chrono::steady_clock::now();
      auto outputs = session_->Run(Ort::RunOptions{nullptr}, inputNames_.data(),
                                   &inputTensor, 1, outputNames_.data(), 1);
      const auto runEnd = std::chrono::steady_clock::now();
      if (outputs.empty() || !outputs[0].IsTensor()) {
        setFallback("invalid_output");
        result.status = status_;
        return result;
      }
      const float *mask = outputs[0].GetTensorData<float>();
      const auto info = outputs[0].GetTensorTypeAndShapeInfo();
      const std::vector<int64_t> shape = info.GetShape();
      uint32_t maskHeight = kSelfieInputHeight;
      uint32_t maskWidth = kSelfieInputWidth;
      if (shape.size() >= 3u) {
        maskHeight = shape[shape.size() - 3u] > 0
                         ? static_cast<uint32_t>(shape[shape.size() - 3u])
                         : maskHeight;
        maskWidth = shape[shape.size() - 2u] > 0
                        ? static_cast<uint32_t>(shape[shape.size() - 2u])
                        : maskWidth;
      }
      const size_t count = static_cast<size_t>(maskWidth) * maskHeight;
      activated_.resize(count);
      bool needsSigmoid = false;
      for (size_t i = 0; i < count; ++i) {
        if (mask[i] < 0.0f || mask[i] > 1.0f) {
          needsSigmoid = true;
          break;
        }
      }
      for (size_t i = 0; i < count; ++i) {
        activated_[i] =
            std::clamp(needsSigmoid ? sigmoid(mask[i]) : mask[i], 0.0f, 1.0f);
      }
      const auto maskStart = std::chrono::steady_clock::now();
      copyModnetAlphaMask(activated_.data(), maskWidth, maskHeight, mapping,
                          input.width, input.height, input.timestampNs,
                          result.mask);
      const auto end = std::chrono::steady_clock::now();
      status_.activeKeyer = "selfie_landscape";
      status_.fallbackActive = false;
      status_.fallbackReason.clear();
      status_.inferenceMs = elapsedMs(start, end);
      status_.metrics.tensorMs = elapsedMs(tensorStart, tensorEnd);
      status_.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
      status_.metrics.maskApplyMs = elapsedMs(maskStart, end);
      status_.metrics.maskWidth = result.mask.width;
      status_.metrics.maskHeight = result.mask.height;
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

  KeyerStatus status() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!loaded_ && status_.fallbackReason == "not_loaded") {
      inspectAvailability();
    }
    return status_;
  }

 private:
  bool ensureLoaded() {
    if (loaded_) {
      return true;
    }
    const ModelManifestEntry entry =
        findModelManifestEntry(options_.modelsDir, "selfie_landscape");
    if (entry.file.empty()) {
      setFallback("model_missing");
      return false;
    }
    modelPath_ = joinModelPath(options_.modelsDir, entry.file);
    status_.modelPath = modelPath_;
    if (!fileExists(modelPath_)) {
      setFallback("model_missing");
      return false;
    }
    if (!entry.sha256.empty() && entry.sha256 != "release-artifact-required") {
      const std::string actualHash = sha256FileHex(modelPath_);
      status_.modelHashOk = actualHash == entry.sha256;
      if (!status_.modelHashOk) {
        setFallback("model_hash_mismatch");
        return false;
      }
    }
#if BROADIFY_ENABLE_MODNET
    try {
      env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING,
                                        "broadify-selfie-keyer");
      Ort::SessionOptions sessionOptions;
      status_.provider = "cpu";
      sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#if defined(_WIN32)
      const OrtSessionOptionsPolicy dmlPolicy =
          makeDirectMlSessionOptionsPolicy(kSelfieInputWidth, kSelfieInputHeight);
      if (dmlPolicy.disableMemPattern) {
        sessionOptions.DisableMemPattern();
      }
      if (dmlPolicy.sequentialExecution) {
        sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
      }
      const OrtDmlApi *dmlApi = nullptr;
      OrtStatus *apiStatus = Ort::GetApi().GetExecutionProviderApi(
          "DML", ORT_API_VERSION, reinterpret_cast<const void **>(&dmlApi));
      if (apiStatus != nullptr) {
        Ort::GetApi().ReleaseStatus(apiStatus);
        dmlApi = nullptr;
      }
      OrtStatus *dmlStatus =
          appendDirectMlOnSelectedAdapter(sessionOptions, dmlApi,
                                          &status_.gpuAdapter);
      if (dmlStatus == nullptr && dmlApi != nullptr) {
        status_.provider = "directml";
        sessionOptions.SetIntraOpNumThreads(dmlPolicy.intraOpThreads);
        for (const auto &configEntry : dmlPolicy.configEntries) {
          sessionOptions.AddConfigEntry(configEntry.first.c_str(),
                                        configEntry.second.c_str());
        }
      } else if (dmlStatus != nullptr) {
        Ort::GetApi().ReleaseStatus(dmlStatus);
      }
      const std::wstring widePath = utf8ToWidePath(modelPath_);
      if (widePath.empty()) {
        setFallback("model_path_invalid");
        return false;
      }
      session_ = std::make_unique<Ort::Session>(*env_, widePath.c_str(),
                                                sessionOptions);
#else
      sessionOptions.SetIntraOpNumThreads(2);
      session_ =
          std::make_unique<Ort::Session>(*env_, modelPath_.c_str(), sessionOptions);
#endif
      Ort::AllocatorWithDefaultOptions allocator;
      Ort::AllocatedStringPtr inputNameAllocated =
          session_->GetInputNameAllocated(0, allocator);
      Ort::AllocatedStringPtr outputNameAllocated =
          session_->GetOutputNameAllocated(0, allocator);
      inputName_ = inputNameAllocated.get();
      outputName_ = outputNameAllocated.get();
      inputNames_[0] = inputName_.c_str();
      outputNames_[0] = outputName_.c_str();
      loaded_ = true;
      status_.activeKeyer = "selfie_landscape";
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

  void inspectAvailability() {
    const ModelManifestEntry entry =
        findModelManifestEntry(options_.modelsDir, "selfie_landscape");
    if (entry.file.empty()) {
      status_.modelPath = joinModelPath(options_.modelsDir, "selfie_landscape.onnx");
      setFallback("model_missing");
      return;
    }
    status_.modelPath = joinModelPath(options_.modelsDir, entry.file);
    if (!fileExists(status_.modelPath)) {
      setFallback("model_missing");
    }
  }

  void buildInputTensor(const VideoFrame &input,
                        std::vector<float> &tensor,
                        ModnetLetterboxMapping *mappingOut) {
    tensor.assign(static_cast<size_t>(kSelfieInputWidth) *
                      kSelfieInputHeight * 3u,
                  0.0f);
    const ModnetLetterboxMapping mapping = modnetLetterboxMapping(
        input.width, input.height, kSelfieInputWidth, kSelfieInputHeight);
    if (mappingOut != nullptr) {
      *mappingOut = mapping;
    }
    for (uint32_t y = 0; y < mapping.contentHeight; ++y) {
      const uint32_t srcY =
          (static_cast<uint64_t>(y) * input.height) / mapping.contentHeight;
      const uint32_t dstY = mapping.contentY + y;
      for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
        const uint32_t srcX =
            (static_cast<uint64_t>(x) * input.width) / mapping.contentWidth;
        const uint32_t dstX = mapping.contentX + x;
        const size_t src = (static_cast<size_t>(srcY) * input.width + srcX) * 4u;
        const size_t dst =
            (static_cast<size_t>(dstY) * kSelfieInputWidth + dstX) * 3u;
        tensor[dst + 0u] = static_cast<float>(input.rgba[src + 0u]) / 255.0f;
        tensor[dst + 1u] = static_cast<float>(input.rgba[src + 1u]) / 255.0f;
        tensor[dst + 2u] = static_cast<float>(input.rgba[src + 2u]) / 255.0f;
      }
    }
  }

  void setFallback(const std::string &reason) {
    status_.activeKeyer = "passthrough";
    status_.backend = "selfie_landscape";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = reason;
    status_.inferenceMs = -1.0;
  }

  SelfieKeyerOptions options_;
  mutable std::mutex mutex_;
  KeyerStatus status_;
  bool loaded_ = false;
  std::string modelPath_;
#if BROADIFY_ENABLE_MODNET
  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::Session> session_;
  std::string inputName_;
  std::string outputName_;
  std::array<const char *, 1> inputNames_ = {nullptr};
  std::array<const char *, 1> outputNames_ = {nullptr};
  std::vector<float> tensor_;
  std::vector<float> activated_;
#endif
};

SelfieKeyer::SelfieKeyer(SelfieKeyerOptions options)
    : options_(std::move(options)), impl_(std::make_unique<Impl>(options_)) {}

SelfieKeyer::~SelfieKeyer() = default;

KeyerResult SelfieKeyer::apply(const VideoFrame &input,
                               const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

KeyerStatus SelfieKeyer::status() const {
  return impl_->status();
}

}  // namespace broadify::meeting
