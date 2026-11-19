#include "live/program_stream_frame_copy.h"

#include "util/pixel_swizzle.h"

#import <Foundation/Foundation.h>

namespace broadify::meeting {

namespace {

constexpr int kPoolMinBuffers = 3;

}  // namespace

ProgramFramePool::~ProgramFramePool() { reset(); }

bool ProgramFramePool::configure(uint32_t width, uint32_t height) {
  reset();
  NSDictionary *attrs = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
    (__bridge NSString *)kCVPixelBufferWidthKey : @(width),
    (__bridge NSString *)kCVPixelBufferHeightKey : @(height),
    (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  NSDictionary *poolAttrs = @{(__bridge NSString *)kCVPixelBufferPoolMinimumBufferCountKey : @(kPoolMinBuffers)};
  if (CVPixelBufferPoolCreate(kCFAllocatorDefault, (__bridge CFDictionaryRef)poolAttrs, (__bridge CFDictionaryRef)attrs, &pool_) !=
      kCVReturnSuccess) {
    pool_ = nullptr;
    return false;
  }
  return true;
}

CVPixelBufferRef ProgramFramePool::createBuffer() {
  CVPixelBufferRef pixelBuffer = nullptr;
  if (pool_ == nullptr ||
      CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool_, &pixelBuffer) != kCVReturnSuccess) {
    return nullptr;
  }
  return pixelBuffer;
}

void ProgramFramePool::reset() {
  if (pool_ != nullptr) {
    CVPixelBufferPoolRelease(pool_);
    pool_ = nullptr;
  }
}

bool copyRgbaFrameToPixelBuffer(const uint8_t *rgba, size_t rgbaSize, uint32_t width, uint32_t height,
                                CVPixelBufferRef pixelBuffer) {
  const size_t srcStride = static_cast<size_t>(width) * 4;
  const size_t rows = static_cast<size_t>(height);
  if (rgbaSize < srcStride * rows) {
    return false;
  }
  CVPixelBufferLockBaseAddress(pixelBuffer, 0);
  uint8_t *dst = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
  const size_t dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
  for (size_t row = 0; row < rows; ++row) {
    swizzleRgbaToBgra(rgba + row * srcStride, dst + row * dstStride, width);
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
  return true;
}

}  // namespace broadify::meeting
