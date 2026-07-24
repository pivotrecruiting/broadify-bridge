#include "keyer/coreml_keyer.h"
#include "keyer/gpu_mask_refine.h"

#include <algorithm>
#include <memory>
#include <chrono>
#include <cstdlib>
#include <vector>

#if defined(__APPLE__)
#import <Accelerate/Accelerate.h>
#import <CoreML/CoreML.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#endif

namespace broadify::meeting {
namespace {

// The converted MODNet.mlpackage is fixed at this square input; the model bakes
// in the (x/127.5 - 1) normalization and outputs a [0,1] grayscale-float16 matte.
constexpr uint32_t kModelSize = 512u;

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

#if defined(__APPLE__)
MLComputeUnits computeUnitsFromEnv() {
  const char *raw = std::getenv("BROADIFY_MEETING_COREML_UNITS");
  const std::string v = raw != nullptr ? raw : "";
  if (v == "cpuOnly") return MLComputeUnitsCPUOnly;
  if (v == "cpuAndGPU") return MLComputeUnitsCPUAndGPU;
  if (v == "cpuAndNeuralEngine") return MLComputeUnitsCPUAndNeuralEngine;
  return MLComputeUnitsAll;  // default: CPU+GPU+ANE, Core ML picks
}

// Refine the mask on the GPU (MPSImageGuidedFilter) instead of the CPU
// joint-bilateral pass. Default ON. Kill-switch: BROADIFY_MEETING_GPU_REFINE=0.
bool gpuRefineEnabled() {
  const char *raw = std::getenv("BROADIFY_MEETING_GPU_REFINE");
  return raw == nullptr || raw[0] != '0';
}
#endif

}  // namespace

class CoreMLKeyer::Impl {
 public:
  explicit Impl(std::string modelsDir) : modelsDir_(std::move(modelsDir)) {
    status_.activeKeyer = "passthrough";
    status_.backend = "coreml_modnet";
    status_.provider = "coreml";
    status_.qualityMode = "realtime";
    status_.fallbackActive = true;
    status_.fallbackReason = "not_loaded";
  }

#if defined(__APPLE__)
  ~Impl() {
    if (pixelBuffer_ != nullptr) {
      CVPixelBufferRelease(pixelBuffer_);
      pixelBuffer_ = nullptr;
    }
  }
#endif

  KeyerResult apply(const VideoFrame &input, const KeyerSettings & /*settings*/) {
    KeyerResult result;
#if defined(__APPLE__)
    if (@available(macOS 13.0, *)) {
      if (!ensureLoaded()) {
        result.status = status_;
        return result;
      }
      @autoreleasepool {
        const auto start = std::chrono::steady_clock::now();
        if (input.rgba.empty() || input.width == 0u || input.height == 0u) {
          setFallback("invalid_frame");
          result.status = status_;
          return result;
        }
        const auto convertStart = std::chrono::steady_clock::now();
        if (!fillPixelBuffer(input)) {
          setFallback("frame_convert_failed");
          result.status = status_;
          return result;
        }
        const auto convertEnd = std::chrono::steady_clock::now();

        MLFeatureValue *imageValue =
            [MLFeatureValue featureValueWithPixelBuffer:pixelBuffer_];
        NSError *error = nil;
        MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc]
            initWithDictionary:@{inputName_ : imageValue}
                         error:&error];
        if (provider == nil) {
          setFallback("input_provider_failed");
          result.status = status_;
          return result;
        }

        const auto runStart = std::chrono::steady_clock::now();
        id<MLFeatureProvider> prediction =
            [model_ predictionFromFeatures:provider error:&error];
        const auto runEnd = std::chrono::steady_clock::now();
        if (prediction == nil) {
          setFallback("inference_failed");
          result.status.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
          result.status = status_;
          return result;
        }

        MLFeatureValue *alphaValue = [prediction featureValueForName:outputName_];
        CVPixelBufferRef maskBuffer =
            alphaValue != nil ? [alphaValue imageBufferValue] : nullptr;
        if (maskBuffer == nullptr) {
          setFallback("no_mask_output");
          result.status = status_;
          return result;
        }

        const auto maskStart = std::chrono::steady_clock::now();
        bool refined = false;
        if (refiner_ != nullptr && refiner_->available()) {
          refined = refiner_->refine(maskBuffer, input, result.mask);
        }
        if (!refined) {
          readAlphaMask(maskBuffer, input.timestampNs, result.mask);
        }
        const auto end = std::chrono::steady_clock::now();

        status_.activeKeyer = "coreml_modnet";
        status_.fallbackActive = false;
        status_.fallbackReason.clear();
        status_.inferenceMs = elapsedMs(start, end);
        status_.metrics = KeyerMetrics{};
        status_.metrics.tensorMs = elapsedMs(convertStart, convertEnd);
        status_.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
        status_.metrics.maskApplyMs = elapsedMs(maskStart, end);
        status_.metrics.maskWidth = result.mask.width;
        status_.metrics.maskHeight = result.mask.height;
        result.status = status_;
        return result;
      }
    }
    setFallback("coreml_requires_macos_13");
    result.status = status_;
    return result;
#else
    (void)input;
    setFallback("coreml_unsupported_platform");
    result.status = status_;
    return result;
#endif
  }

  void *predictMaskTexture(const VideoFrame &input, uint32_t &width, uint32_t &height) {
    width = 0;
    height = 0;
#if defined(__APPLE__)
    if (@available(macOS 13.0, *)) {
      if (!ensureLoaded()) return nullptr;
      @autoreleasepool {
        if (input.rgba.empty() || input.width == 0u || input.height == 0u) {
          return nullptr;
        }
        if (!fillPixelBuffer(input)) return nullptr;
        MLFeatureValue *imageValue =
            [MLFeatureValue featureValueWithPixelBuffer:pixelBuffer_];
        NSError *error = nil;
        MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc]
            initWithDictionary:@{inputName_ : imageValue}
                         error:&error];
        if (provider == nil) return nullptr;
        id<MLFeatureProvider> prediction =
            [model_ predictionFromFeatures:provider error:&error];
        if (prediction == nil) return nullptr;
        MLFeatureValue *alphaValue = [prediction featureValueForName:outputName_];
        CVPixelBufferRef maskBuffer =
            alphaValue != nil ? [alphaValue imageBufferValue] : nullptr;
        if (maskBuffer == nullptr) return nullptr;
        if (refiner_ == nullptr) {
          refiner_ = std::make_unique<GpuMaskRefiner>();
        }
        if (!refiner_->available()) return nullptr;
        status_.activeKeyer = "coreml_modnet";
        status_.fallbackActive = false;
        status_.fallbackReason.clear();
        // Alpha CVPixelBuffer stays inside this scope; only the persistent
        // refined-mask texture handle leaves.
        return refiner_->refineToTexture(maskBuffer, input, width, height);
      }
    }
    return nullptr;
#else
    (void)input;
    return nullptr;
#endif
  }

#if defined(__APPLE__)
 private:
  bool ensureLoaded() {
    if (loaded_) return true;
    if (loadAttempted_) return false;
    loadAttempted_ = true;

    if (@available(macOS 13.0, *)) {
      @autoreleasepool {
        NSString *dir = [NSString stringWithUTF8String:modelsDir_.c_str()];
        // The model file is selectable so a smaller/faster model (e.g. 320px for
        // 30 fps) can be A/B tested against the default 512px one. The input size
        // is queried from whichever model loads, so the rest of the path adapts.
        const char *modelEnv = std::getenv("BROADIFY_MEETING_COREML_MODEL");
        NSString *modelFile = (modelEnv != nullptr && modelEnv[0] != '\0')
                                  ? [NSString stringWithUTF8String:modelEnv]
                                  : @"MODNet.mlpackage";
        NSString *path = [dir stringByAppendingPathComponent:modelFile];
        status_.modelPath = std::string([path UTF8String]);
        NSURL *url = [NSURL fileURLWithPath:path];
        if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
          setFallback("model_missing");
          return false;
        }
        NSError *error = nil;
        // Compile the .mlpackage (Core ML runs the compiled .mlmodelc).
        NSURL *compiledURL = [MLModel compileModelAtURL:url error:&error];
        if (compiledURL == nil) {
          setFallback("model_compile_failed");
          return false;
        }
        MLModelConfiguration *config = [[MLModelConfiguration alloc] init];
        config.computeUnits = computeUnitsFromEnv();
        model_ = [MLModel modelWithContentsOfURL:compiledURL
                                   configuration:config
                                           error:&error];
        if (model_ == nil) {
          setFallback("model_load_failed");
          return false;
        }
        // Resolve the input/output feature names (expected "image"/"alpha").
        NSString *inName = [[model_.modelDescription.inputDescriptionsByName allKeys] firstObject];
        NSString *outName = [[model_.modelDescription.outputDescriptionsByName allKeys] firstObject];
        inputName_ = inName != nil ? inName : @"image";
        outputName_ = outName != nil ? outName : @"alpha";
        MLImageConstraint *inputConstraint =
            model_.modelDescription.inputDescriptionsByName[inputName_].imageConstraint;
        if (inputConstraint != nil && inputConstraint.pixelsWide > 0) {
          modelSize_ = static_cast<uint32_t>(inputConstraint.pixelsWide);
        }
        if (gpuRefineEnabled()) {
          refiner_ = std::make_unique<GpuMaskRefiner>();
        }
        loaded_ = true;
        status_.activeKeyer = "coreml_modnet";
        status_.fallbackActive = false;
        status_.fallbackReason.clear();
        return true;
      }
    }
    setFallback("coreml_requires_macos_13");
    return false;
  }

  bool ensurePixelBuffer() {
    if (pixelBuffer_ != nullptr) return true;
    NSDictionary *attributes = @{
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
      (id)kCVPixelBufferMetalCompatibilityKey : @YES,
    };
    const CVReturn status = CVPixelBufferCreate(
        kCFAllocatorDefault, modelSize_, modelSize_, kCVPixelFormatType_32BGRA,
        (__bridge CFDictionaryRef)attributes, &pixelBuffer_);
    return status == kCVReturnSuccess && pixelBuffer_ != nullptr;
  }

  // Resize the camera RGBA frame to kModelSize and write it BGRA into the input
  // pixel buffer (Core ML maps BGRA -> the model's RGB input).
  bool fillPixelBuffer(const VideoFrame &frame) {
    if (!ensurePixelBuffer()) return false;

    vImage_Buffer source;
    source.data = const_cast<uint8_t *>(frame.rgba.data());
    source.height = frame.height;
    source.width = frame.width;
    source.rowBytes = static_cast<size_t>(frame.width) * 4u;

    vImage_Buffer scaled = source;
    if (frame.width != modelSize_ || frame.height != modelSize_) {
      scaleScratch_.resize(static_cast<size_t>(modelSize_) * modelSize_ * 4u);
      scaled.data = scaleScratch_.data();
      scaled.width = modelSize_;
      scaled.height = modelSize_;
      scaled.rowBytes = static_cast<size_t>(modelSize_) * 4u;
      if (vImageScale_ARGB8888(&source, &scaled, nullptr, kvImageNoFlags) != kvImageNoError) {
        return false;
      }
    }

    if (CVPixelBufferLockBaseAddress(pixelBuffer_, 0) != kCVReturnSuccess) {
      return false;
    }
    vImage_Buffer destination;
    destination.data = CVPixelBufferGetBaseAddress(pixelBuffer_);
    destination.width = modelSize_;
    destination.height = modelSize_;
    destination.rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer_);
    const uint8_t kRgbaToBgra[4] = {2, 1, 0, 3};
    const vImage_Error permute =
        vImagePermuteChannels_ARGB8888(&scaled, &destination, kRgbaToBgra, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(pixelBuffer_, 0);
    return permute == kvImageNoError;
  }

  // Read the OneComponent16Half alpha buffer into an 8-bit AlphaMask.
  void readAlphaMask(CVPixelBufferRef buffer, uint64_t timestampNs, AlphaMask &out) {
    CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    const size_t width = CVPixelBufferGetWidth(buffer);
    const size_t height = CVPixelBufferGetHeight(buffer);
    const size_t rowBytes = CVPixelBufferGetBytesPerRow(buffer);
    void *base = CVPixelBufferGetBaseAddress(buffer);
    if (base == nullptr || width == 0u || height == 0u) {
      CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
      return;
    }
    out.width = static_cast<uint32_t>(width);
    out.height = static_cast<uint32_t>(height);
    out.timestampNs = timestampNs;
    out.alpha.assign(width * height, 0u);

    // half(16F) -> float -> uint8, row by row (respect stride padding).
    floatScratch_.resize(width);
    for (size_t y = 0; y < height; ++y) {
      const uint8_t *row = static_cast<const uint8_t *>(base) + y * rowBytes;
      vImage_Buffer src16{const_cast<uint8_t *>(row), 1, width, rowBytes};
      vImage_Buffer dstF{floatScratch_.data(), 1, width, width * sizeof(float)};
      if (vImageConvert_Planar16FtoPlanarF(&src16, &dstF, kvImageNoFlags) != kvImageNoError) {
        continue;
      }
      uint8_t *outRow = out.alpha.data() + y * width;
      for (size_t x = 0; x < width; ++x) {
        const float a = std::clamp(floatScratch_[x], 0.0f, 1.0f);
        outRow[x] = static_cast<uint8_t>(a * 255.0f + 0.5f);
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  }
#endif

  void setFallback(const std::string &reason) {
    status_.activeKeyer = "passthrough";
    status_.backend = "coreml_modnet";
    status_.provider = "coreml";
    status_.fallbackActive = true;
    status_.fallbackReason = reason;
    status_.inferenceMs = -1.0;
  }

  std::string modelsDir_;
  KeyerStatus status_;
  bool loaded_ = false;
  bool loadAttempted_ = false;
#if defined(__APPLE__)
  MLModel *model_ = nil;
  NSString *inputName_ = nil;
  NSString *outputName_ = nil;
  CVPixelBufferRef pixelBuffer_ = nullptr;
  uint32_t modelSize_ = kModelSize;  // queried from the model (512 or 320)
  std::vector<uint8_t> scaleScratch_;
  std::vector<float> floatScratch_;
  std::unique_ptr<GpuMaskRefiner> refiner_;
#endif
};

CoreMLKeyer::CoreMLKeyer(std::string modelsDir)
    : impl_(std::make_unique<Impl>(std::move(modelsDir))) {}

CoreMLKeyer::~CoreMLKeyer() = default;

KeyerResult CoreMLKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

void *CoreMLKeyer::predictMaskTexture(const VideoFrame &input, uint32_t &width, uint32_t &height) {
  return impl_->predictMaskTexture(input, width, height);
}

}  // namespace broadify::meeting
