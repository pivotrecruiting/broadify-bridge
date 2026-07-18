#include "keyer/vision_keyer.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

#if defined(__APPLE__)
#import <Accelerate/Accelerate.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#endif

namespace broadify::meeting {
namespace {

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

std::string normalizedQualityMode(const std::string &qualityMode) {
  if (qualityMode == "fast" || qualityMode == "accurate") {
    return qualityMode;
  }
  return "balanced";
}

#if defined(__APPLE__)
struct VisionInputSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

VisionInputSize visionInputSize(const VideoFrame &frame, const KeyerSettings &settings) {
  const uint32_t maxWidth = std::max(1u, settings.maxInputWidth);
  const uint32_t maxHeight = std::max(1u, settings.maxInputHeight);
  const double scale = std::min(
      1.0,
      std::min(
          static_cast<double>(maxWidth) / static_cast<double>(frame.width),
          static_cast<double>(maxHeight) / static_cast<double>(frame.height)));
  VisionInputSize size;
  size.width = std::max(1u, static_cast<uint32_t>(std::lround(frame.width * scale)));
  size.height = std::max(1u, static_cast<uint32_t>(std::lround(frame.height * scale)));
  return size;
}

VNGeneratePersonSegmentationRequestQualityLevel visionQualityLevel(const std::string &qualityMode) {
  if (qualityMode == "fast") {
    return VNGeneratePersonSegmentationRequestQualityLevelFast;
  }
  if (qualityMode == "accurate") {
    return VNGeneratePersonSegmentationRequestQualityLevelAccurate;
  }
  return VNGeneratePersonSegmentationRequestQualityLevelBalanced;
}

void copyMask(CVPixelBufferRef maskBuffer, uint64_t timestampNs, AlphaMask &outputMask, KeyerMetrics &metrics) {
  if (maskBuffer == nullptr) {
    return;
  }

  CVPixelBufferLockBaseAddress(maskBuffer, kCVPixelBufferLock_ReadOnly);
  const size_t maskWidth = CVPixelBufferGetWidth(maskBuffer);
  const size_t maskHeight = CVPixelBufferGetHeight(maskBuffer);
  const size_t maskStride = CVPixelBufferGetBytesPerRow(maskBuffer);
  const auto *mask = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(maskBuffer));
  if (mask == nullptr || maskWidth == 0u || maskHeight == 0u) {
    CVPixelBufferUnlockBaseAddress(maskBuffer, kCVPixelBufferLock_ReadOnly);
    return;
  }
  metrics.maskWidth = static_cast<uint32_t>(std::min<size_t>(maskWidth, UINT32_MAX));
  metrics.maskHeight = static_cast<uint32_t>(std::min<size_t>(maskHeight, UINT32_MAX));
  outputMask.width = metrics.maskWidth;
  outputMask.height = metrics.maskHeight;
  outputMask.timestampNs = timestampNs;
  outputMask.alpha.assign(static_cast<size_t>(outputMask.width) * outputMask.height, 0u);
  for (uint32_t y = 0; y < outputMask.height; ++y) {
    const uint8_t *row = mask + static_cast<size_t>(y) * maskStride;
    const size_t outputOffset = static_cast<size_t>(y) * outputMask.width;
    std::copy(row, row + outputMask.width, outputMask.alpha.data() + outputOffset);
  }
  CVPixelBufferUnlockBaseAddress(maskBuffer, kCVPixelBufferLock_ReadOnly);
}

// Fraction of the mask that is confident foreground. A low-confidence frame
// (backlight, bright window, low contrast) can make the stateful sequence
// handler emit a near-full-frame foreground mask. The whole background stops
// keying and can then stick in that state until strong motion re-converges it.
constexpr double kDegenerateCoverageThreshold = 0.92;
bool isDegenerateCoverage(const AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return false;
  }
  size_t foreground = 0u;
  for (const uint8_t alpha : mask.alpha) {
    if (alpha >= 128u) {
      ++foreground;
    }
  }
  return static_cast<double>(foreground) /
             static_cast<double>(mask.alpha.size()) >
         kDegenerateCoverageThreshold;
}
#endif

}  // namespace

class VisionKeyer::Impl {
 public:
  Impl() = default;

#if defined(__APPLE__)
  ~Impl() {
    if (pixelBuffer_ != nullptr) {
      CVPixelBufferRelease(pixelBuffer_);
      pixelBuffer_ = nullptr;
    }
  }
#endif

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) {
    KeyerResult result;
    result.status.activeKeyer = "passthrough";
    result.status.backend = "vision_person_segmentation";
    result.status.qualityMode = normalizedQualityMode(settings.qualityMode);
    result.status.provider = "vision_sequence";
    result.status.fallbackActive = true;
    result.status.fallbackReason = "vision_unavailable";

#if defined(__APPLE__)
    if (@available(macOS 12.0, *)) {
      @autoreleasepool {
        const auto start = std::chrono::steady_clock::now();
        if (input.rgba.empty() || input.width == 0u || input.height == 0u) {
          result.status.fallbackReason = "invalid_frame";
          return result;
        }
        const auto convertStart = std::chrono::steady_clock::now();
        if (!fillPixelBuffer(input, settings)) {
          result.status.fallbackReason = "frame_convert_failed";
          return result;
        }
        const auto convertEnd = std::chrono::steady_clock::now();

        VNGeneratePersonSegmentationRequest *request = requestForCurrentThread();
        VNSequenceRequestHandler *handler = sequenceHandlerForCurrentThread();
        request.qualityLevel = visionQualityLevel(result.status.qualityMode);

        NSError *error = nil;
        const auto runStart = std::chrono::steady_clock::now();
        const BOOL ok = [handler performRequests:@[ request ] onCVPixelBuffer:pixelBuffer_ error:&error];
        const auto runEnd = std::chrono::steady_clock::now();
        result.status.metrics.tensorMs = elapsedMs(convertStart, convertEnd);

        if (!ok || request.results.count == 0u) {
          // A failed request can leave the sequence handler in a bad temporal
          // state; start the next frame fresh.
          resetSequenceHandler();
          result.status.fallbackReason = "vision_request_failed";
          result.status.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
          return result;
        }

        VNPixelBufferObservation *observation = (VNPixelBufferObservation *)request.results.firstObject;
        const auto maskStart = std::chrono::steady_clock::now();
        copyMask(observation.pixelBuffer, input.timestampNs, result.mask, result.status.metrics);
        const auto end = std::chrono::steady_clock::now();

        // Degenerate-mask watchdog: if this mask is an implausible near-full-frame
        // foreground (the "whole background un-keyed" stick), recreate the
        // sequence handler so the NEXT frame re-inferences from a clean temporal
        // state instead of staying stuck until the user waves an arm. The
        // current (bad) mask is still returned; the pipeline holds its last good
        // mask rather than publishing this one.
        if (isDegenerateCoverage(result.mask)) {
          resetSequenceHandler();
        }

        result.status.activeKeyer = "vision_person_segmentation";
        result.status.fallbackActive = false;
        result.status.fallbackReason.clear();
        result.status.inferenceMs = elapsedMs(start, end);
        result.status.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
        result.status.metrics.maskApplyMs = elapsedMs(maskStart, end);
        return result;
      }
    }
    result.status.fallbackReason = "vision_requires_macos_12";
    return result;
#else
    result.status.fallbackReason = "vision_unsupported_platform";
    return result;
#endif
  }

#if defined(__APPLE__)
 private:
  bool ensurePixelBuffer(uint32_t width, uint32_t height) {
    if (pixelBuffer_ != nullptr &&
        CVPixelBufferGetWidth(pixelBuffer_) == width &&
        CVPixelBufferGetHeight(pixelBuffer_) == height) {
      return true;
    }
    if (pixelBuffer_ != nullptr) {
      CVPixelBufferRelease(pixelBuffer_);
      pixelBuffer_ = nullptr;
    }
    // IOSurface backing lets Vision read the buffer without an extra copy.
    NSDictionary *attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey : @{}};
    const CVReturn status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        (__bridge CFDictionaryRef)attributes,
        &pixelBuffer_);
    return status == kCVReturnSuccess && pixelBuffer_ != nullptr;
  }

  bool fillPixelBuffer(const VideoFrame &frame, const KeyerSettings &settings) {
    const VisionInputSize target = visionInputSize(frame, settings);
    if (!ensurePixelBuffer(target.width, target.height)) {
      return false;
    }

    vImage_Buffer source;
    source.data = const_cast<uint8_t *>(frame.rgba.data());
    source.height = frame.height;
    source.width = frame.width;
    source.rowBytes = static_cast<size_t>(frame.width) * 4u;

    vImage_Buffer scaled = source;
    if (target.width != frame.width || target.height != frame.height) {
      scaleScratch_.resize(static_cast<size_t>(target.width) * target.height * 4u);
      scaled.data = scaleScratch_.data();
      scaled.height = target.height;
      scaled.width = target.width;
      scaled.rowBytes = static_cast<size_t>(target.width) * 4u;
      if (vImageScale_ARGB8888(&source, &scaled, nullptr, kvImageNoFlags) != kvImageNoError) {
        return false;
      }
    }

    if (CVPixelBufferLockBaseAddress(pixelBuffer_, 0) != kCVReturnSuccess) {
      return false;
    }
    vImage_Buffer destination;
    destination.data = CVPixelBufferGetBaseAddress(pixelBuffer_);
    destination.height = target.height;
    destination.width = target.width;
    destination.rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer_);
    const uint8_t kRgbaToBgra[4] = {2, 1, 0, 3};
    const vImage_Error permuteStatus =
        vImagePermuteChannels_ARGB8888(&scaled, &destination, kRgbaToBgra, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(pixelBuffer_, 0);
    return permuteStatus == kvImageNoError;
  }

  VNGeneratePersonSegmentationRequest *requestForCurrentThread() {
    if (request_ == nil) {
      request_ = [[VNGeneratePersonSegmentationRequest alloc] init];
      request_.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelBalanced;
      request_.outputPixelFormat = kCVPixelFormatType_OneComponent8;
    }
    return request_;
  }

  VNSequenceRequestHandler *sequenceHandlerForCurrentThread() {
    if (sequenceHandler_ == nil) {
      sequenceHandler_ = [[VNSequenceRequestHandler alloc] init];
    }
    return sequenceHandler_;
  }

  // Drop the sequence handler so the next frame builds a fresh one, clearing
  // Vision's accumulated temporal state (used to break out of a stuck mask).
  void resetSequenceHandler() { sequenceHandler_ = nil; }

  VNSequenceRequestHandler *sequenceHandler_ = nil;
  VNGeneratePersonSegmentationRequest *request_ = nil;
  CVPixelBufferRef pixelBuffer_ = nullptr;
  std::vector<uint8_t> scaleScratch_;
#endif
};

VisionKeyer::VisionKeyer() : impl_(std::make_unique<Impl>()) {}

VisionKeyer::~VisionKeyer() = default;

KeyerResult VisionKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

}  // namespace broadify::meeting
