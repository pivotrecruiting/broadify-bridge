#include "keyer/vision_keyer.h"

#include <algorithm>
#include <chrono>
#include <cmath>
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
struct MaskSample {
  size_t lower = 0u;
  size_t upper = 0u;
  uint32_t upperWeight = 0u;
};

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

void applyMask(CVPixelBufferRef maskBuffer, VideoFrame &frame, KeyerMetrics &metrics) {
  if (maskBuffer == nullptr || frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
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

  std::vector<MaskSample> xSamples(frame.width);
  std::vector<MaskSample> ySamples(frame.height);
  for (uint32_t x = 0; x < frame.width; ++x) {
    const double sourceX = frame.width > 1u
        ? (static_cast<double>(x) * static_cast<double>(maskWidth - 1u)) / static_cast<double>(frame.width - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceX));
    xSamples[x].lower = lower;
    xSamples[x].upper = std::min(maskWidth - 1u, lower + 1u);
    xSamples[x].upperWeight = static_cast<uint32_t>(std::round((sourceX - static_cast<double>(lower)) * 256.0));
  }
  for (uint32_t y = 0; y < frame.height; ++y) {
    const double sourceY = frame.height > 1u
        ? (static_cast<double>(y) * static_cast<double>(maskHeight - 1u)) / static_cast<double>(frame.height - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceY));
    ySamples[y].lower = lower;
    ySamples[y].upper = std::min(maskHeight - 1u, lower + 1u);
    ySamples[y].upperWeight = static_cast<uint32_t>(std::round((sourceY - static_cast<double>(lower)) * 256.0));
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    const MaskSample &sampleY = ySamples[y];
    const uint32_t yWeight = sampleY.upperWeight;
    const uint32_t inverseYWeight = 256u - yWeight;
    const uint8_t *row0 = mask + sampleY.lower * maskStride;
    const uint8_t *row1 = mask + sampleY.upper * maskStride;
    for (uint32_t x = 0; x < frame.width; ++x) {
      const MaskSample &sampleX = xSamples[x];
      const uint32_t xWeight = sampleX.upperWeight;
      const uint32_t inverseXWeight = 256u - xWeight;
      const uint32_t top =
          static_cast<uint32_t>(row0[sampleX.lower]) * inverseXWeight +
          static_cast<uint32_t>(row0[sampleX.upper]) * xWeight;
      const uint32_t bottom =
          static_cast<uint32_t>(row1[sampleX.lower]) * inverseXWeight +
          static_cast<uint32_t>(row1[sampleX.upper]) * xWeight;
      const uint32_t alpha = (top * inverseYWeight + bottom * yWeight + 32768u) >> 16u;
      const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      frame.rgba[offset + 3u] = static_cast<uint8_t>(std::min(alpha, 255u));
    }
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
    result.status.provider = "vision";
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
        request.qualityLevel = visionQualityLevel(result.status.qualityMode);

        NSError *error = nil;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        const auto runStart = std::chrono::steady_clock::now();
        const BOOL ok = [handler performRequests:@[ request ] error:&error];
        const auto runEnd = std::chrono::steady_clock::now();
        CGImageRelease(image);

        if (!ok || request.results.count == 0u) {
          result.status.fallbackReason = "vision_request_failed";
          result.status.metrics.sessionRunMs = elapsedMs(runStart, runEnd);
          return result;
        }

        VNPixelBufferObservation *observation = (VNPixelBufferObservation *)request.results.firstObject;
        const auto maskStart = std::chrono::steady_clock::now();
        applyMask(observation.pixelBuffer, result.frame, result.status.metrics);
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

  VNGeneratePersonSegmentationRequest *request_ = nil;
#endif
};

VisionKeyer::VisionKeyer() : impl_(std::make_unique<Impl>()) {}

VisionKeyer::~VisionKeyer() = default;

KeyerResult VisionKeyer::apply(const VideoFrame &input, const KeyerSettings &settings) {
  return impl_->apply(input, settings);
}

}  // namespace broadify::meeting
