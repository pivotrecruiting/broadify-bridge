#include "keyer/vision_keyer.h"

#include <algorithm>
#include <chrono>
#include <vector>

#if defined(__APPLE__)
#import <CoreGraphics/CoreGraphics.h>
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
void releaseFrameData(void *, const void *, size_t) {}

CGImageRef createImageFromFrame(const VideoFrame &frame) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return nullptr;
  }
  CGDataProviderRef provider = CGDataProviderCreateWithData(
      nullptr, frame.rgba.data(), frame.rgba.size(), releaseFrameData);
  if (provider == nullptr) {
    return nullptr;
  }
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGImageRef image = CGImageCreate(
      frame.width,
      frame.height,
      8,
      32,
      static_cast<size_t>(frame.width) * 4u,
      colorSpace,
      kCGImageAlphaLast | kCGBitmapByteOrder32Big,
      provider,
      nullptr,
      false,
      kCGRenderingIntentDefault);
  if (colorSpace != nullptr) {
    CGColorSpaceRelease(colorSpace);
  }
  CGDataProviderRelease(provider);
  return image;
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

void applyMaskToFrame(const AlphaMask &mask, VideoFrame &frame) {
  if (mask.alpha.empty() || frame.rgba.empty() || mask.width == 0u || mask.height == 0u || frame.width == 0u || frame.height == 0u) {
    return;
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    const uint32_t maskY = static_cast<uint32_t>((static_cast<uint64_t>(y) * mask.height) / frame.height);
    for (uint32_t x = 0; x < frame.width; ++x) {
      const uint32_t maskX = static_cast<uint32_t>((static_cast<uint64_t>(x) * mask.width) / frame.width);
      const size_t frameOffset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      const size_t maskOffset = static_cast<size_t>(maskY) * mask.width + maskX;
      frame.rgba[frameOffset + 3u] = mask.alpha[maskOffset];
    }
  }
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
#endif

}  // namespace

class VisionKeyer::Impl {
 public:
  Impl() = default;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) {
    KeyerResult result;
    result.frame = copyPassthroughFrame(input);
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
        CGImageRef image = createImageFromFrame(input);
        if (image == nullptr) {
          result.status.fallbackReason = "invalid_frame";
          return result;
        }

        VNGeneratePersonSegmentationRequest *request = requestForCurrentThread();
        VNSequenceRequestHandler *handler = sequenceHandlerForCurrentThread();
        request.qualityLevel = visionQualityLevel(result.status.qualityMode);

        NSError *error = nil;
        const auto runStart = std::chrono::steady_clock::now();
        const BOOL ok = [handler performRequests:@[ request ] onCGImage:image error:&error];
        const auto runEnd = std::chrono::steady_clock::now();
        CGImageRelease(image);

        if (!ok || request.results.count == 0u) {
          result.status.fallbackReason = "vision_request_failed";
          result.status.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
          return result;
        }

        VNPixelBufferObservation *observation = (VNPixelBufferObservation *)request.results.firstObject;
        const auto maskStart = std::chrono::steady_clock::now();
        copyMask(observation.pixelBuffer, input.timestampNs, result.mask, result.status.metrics);
        applyMaskToFrame(result.mask, result.frame);
        const auto end = std::chrono::steady_clock::now();

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

  VNSequenceRequestHandler *sequenceHandler_ = nil;
  VNGeneratePersonSegmentationRequest *request_ = nil;
#endif
};

VisionKeyer::VisionKeyer() : impl_(std::make_unique<Impl>()) {}

VisionKeyer::~VisionKeyer() = default;

KeyerResult VisionKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

}  // namespace broadify::meeting
