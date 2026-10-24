#import <CoreVideo/CoreVideo.h>

#include "common/monotonic_clock.h"
#include "capture/video_source.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <thread>

namespace broadify::pgm {
namespace {

/**
 * Colour bars with a moving block and a binary frame counter in the top-left
 * corner (8 cells, 1 = white). Lets the glass-to-glass measurement read the
 * frame index back from a camera pointed at the viewer's screen.
 */
class SyntheticSource final : public VideoSource {
 public:
  SyntheticSource(uint32_t width, uint32_t height, double fps) : width_(width & ~1u), height_(height & ~1u), fps_(fps) {}
  ~SyntheticSource() override { stop(); }

  bool start(FrameSink sink, std::string &, std::string &) override {
    if (running_.exchange(true)) {
      return true;
    }
    sink_ = std::move(sink);
    thread_ = std::thread([this]() { run(); });
    return true;
  }

  void stop() override {
    if (!running_.exchange(false)) {
      return;
    }
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  bool isRunning() const override { return running_.load(); }

 private:
  void run() {
    const auto period = std::chrono::nanoseconds(static_cast<int64_t>(1e9 / fps_));
    auto next = std::chrono::steady_clock::now();
    uint64_t index = 0;
    while (running_.load()) {
      CVPixelBufferRef buffer = nullptr;
      NSDictionary *attrs = @{(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey : @{}};
      if (CVPixelBufferCreate(kCFAllocatorDefault, width_, height_, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                              (__bridge CFDictionaryRef)attrs, &buffer) == kCVReturnSuccess) {
        paint(buffer, index);
        CapturedFrame frame;
        frame.pixelBuffer = buffer;
        frame.width = width_;
        frame.height = height_;
        frame.pixelFormat = "nv12";
        frame.captureNs = monotonicNowNs();
        sink_(frame);
        CVPixelBufferRelease(buffer);
      }
      ++index;
      next += period;
      std::this_thread::sleep_until(next);
    }
  }

  void paint(CVPixelBufferRef buffer, uint64_t index) {
    CVPixelBufferLockBaseAddress(buffer, 0);
    uint8_t *y = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 0));
    uint8_t *uv = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 1));
    const size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
    const size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
    // SMPTE-like bars: (Y, U, V) per column band.
    static const uint8_t BARS[8][3] = {{235, 128, 128}, {210, 16, 146}, {170, 166, 16}, {145, 54, 34},
                                       {106, 202, 222}, {81, 90, 240}, {41, 240, 110}, {16, 128, 128}};
    const uint32_t band = std::max<uint32_t>(width_ / 8, 1);
    const uint32_t blockX = static_cast<uint32_t>((index * 8) % std::max<uint64_t>(width_ - 64, 1));
    for (uint32_t row = 0; row < height_; ++row) {
      uint8_t *yRow = y + row * yStride;
      for (uint32_t col = 0; col < width_; ++col) {
        const uint8_t *bar = BARS[std::min<uint32_t>(col / band, 7)];
        uint8_t value = bar[0];
        if (row >= height_ / 2 && row < height_ / 2 + 64 && col >= blockX && col < blockX + 64) {
          value = 235;
        }
        // Frame counter: 8 cells of 32x32 px, bit i set -> white.
        if (row < 32 && col < 8 * 32) {
          value = (index >> (col / 32)) & 1 ? 235 : 16;
        }
        yRow[col] = value;
      }
      if ((row & 1) == 0) {
        uint8_t *uvRow = uv + (row / 2) * uvStride;
        for (uint32_t col = 0; col < width_; col += 2) {
          const uint8_t *bar = BARS[std::min<uint32_t>(col / band, 7)];
          uvRow[col] = bar[1];
          uvRow[col + 1] = bar[2];
        }
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
  }

  uint32_t width_;
  uint32_t height_;
  double fps_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  FrameSink sink_;
};

}  // namespace

std::unique_ptr<VideoSource> createSyntheticSource(uint32_t width, uint32_t height, double fps) {
  return std::make_unique<SyntheticSource>(width, height, fps);
}

}  // namespace broadify::pgm
