#include "keyer/vision_keyer.h"

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

void applyMask(CVPixelBufferRef maskBuffer, VideoFrame &frame) {
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

  for (uint32_t y = 0; y < frame.height; ++y) {
    const size_t maskY = (static_cast<uint64_t>(y) * maskHeight) / frame.height;
    const uint8_t *maskRow = mask + maskY * maskStride;
    for (uint32_t x = 0; x < frame.width; ++x) {
      const size_t maskX = (static_cast<uint64_t>(x) * maskWidth) / frame.width;
      const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      frame.rgba[offset + 3u] = maskRow[maskX];
    }
  }
  CVPixelBufferUnlockBaseAddress(maskBuffer, kCVPixelBufferLock_ReadOnly);
}
#endif

}  // namespace

class VisionKeyer::Impl {
 public:
  Impl() = default;

  KeyerResult apply(const VideoFrame &input) {
    KeyerResult result;
    result.frame = copyPassthroughFrame(input);
    result.status.activeKeyer = "passthrough";
    result.status.backend = "vision_person_segmentation";
    result.status.qualityMode = "benchmark";
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
        applyMask(observation.pixelBuffer, result.frame);
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

KeyerResult VisionKeyer::apply(const VideoFrame &input) {
  return impl_->apply(input);
}

}  // namespace broadify::meeting
