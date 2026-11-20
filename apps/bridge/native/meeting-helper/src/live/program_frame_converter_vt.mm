#include "live/program_frame_converter_vt.h"

#include "live/program_frame_converter.h"
#include "preview/preview_frame_store.h"
#include "util/pixel_swizzle.h"

#import <Foundation/Foundation.h>

namespace broadify::meeting {

namespace {

constexpr int kPoolMinBuffers = 3;

}  // namespace

ProgramFramePool::~ProgramFramePool() { reset(); }

bool ProgramFramePool::ensure(uint32_t width, uint32_t height) {
  if (pool_ != nullptr && width == width_ && height == height_) {
    return true;
  }
  reset();
  if (width == 0 || height == 0) {
    return false;
  }
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
  width_ = width;
  height_ = height;
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
  width_ = 0;
  height_ = 0;
}

bool copyRgbaFrameToPixelBuffer(const uint8_t *rgba, size_t rgbaSize, uint32_t width, uint32_t height,
                                CVPixelBufferRef pixelBuffer) {
  const size_t srcStride = static_cast<size_t>(width) * 4;
  const size_t rows = static_cast<size_t>(height);
  if (rgba == nullptr || pixelBuffer == nullptr || rgbaSize < srcStride * rows) {
    return false;
  }
  if (CVPixelBufferGetPixelFormatType(pixelBuffer) != kCVPixelFormatType_32BGRA ||
      CVPixelBufferGetWidth(pixelBuffer) != width || CVPixelBufferGetHeight(pixelBuffer) != height) {
    return false;
  }
  if (CVPixelBufferLockBaseAddress(pixelBuffer, 0) != kCVReturnSuccess) {
    return false;
  }
  uint8_t *dst = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
  const size_t dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
  const bool fits = dst != nullptr && dstStride >= srcStride;
  if (fits) {
    for (size_t row = 0; row < rows; ++row) {
      swizzleRgbaToBgra(rgba + row * srcStride, dst + row * dstStride, width);
    }
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
  return fits;
}

namespace {

// The macOS converter of the program stream: one RGBA→BGRA pass straight into a pooled buffer.
class VideoToolboxProgramFrameConverter final : public ProgramFrameConverter {
 public:
  bool prepare(uint32_t width, uint32_t height) override { return pool_.ensure(width, height); }

  std::string failure() const override { return "CVPixelBufferPool for the program stream could not be created."; }

  bool convert(const PreviewFrame &frame, live::CapturedFrame &out) override {
    CVPixelBufferRef pixelBuffer = pool_.createBuffer();
    if (pixelBuffer == nullptr) {
      return false;  // every pooled buffer still sits in the encoder: drop, never block
    }
    if (!copyRgbaFrameToPixelBuffer(frame.rgba.data(), frame.rgba.size(), frame.width, frame.height, pixelBuffer)) {
      CVPixelBufferRelease(pixelBuffer);
      return false;  // buffer and frame geometry disagree: drop, never write past the buffer
    }
    out.pixelBuffer = pixelBuffer;
    out.width = frame.width;
    out.height = frame.height;
    out.pixelFormat = "bgra";
    return true;
  }

  void release(live::CapturedFrame &frame) override {
    CVPixelBufferRelease(frame.pixelBuffer);  // VideoToolbox retains it for the encode
    frame.pixelBuffer = nullptr;
  }

  void reset() override { pool_.reset(); }

  // As before the converter existed: straight from the store's frame, and an encoder is asked for with every frame.
  bool runsUnderStoreLock() const override { return true; }
  bool pacesEncoderRetries() const override { return false; }

 private:
  ProgramFramePool pool_;
};

}  // namespace

std::unique_ptr<ProgramFrameConverter> createProgramFrameConverter() {
  return std::make_unique<VideoToolboxProgramFrameConverter>();
}

}  // namespace broadify::meeting
