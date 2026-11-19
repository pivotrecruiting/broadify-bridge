// Test pattern source in plain C++ for platforms without CoreVideo (Windows,
// CI): the same picture as synthetic_source.mm, delivered as NV12 planes in
// CPU memory. Keep the two paint routines in step.
#include "capture/video_source.h"
#include "live_stream/monotonic_clock.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

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

  bool start(FrameSink sink, std::string &errorCode, std::string &error) override {
    if (width_ == 0 || height_ == 0 || !(fps_ > 0.0)) {
      errorCode = "unsupported_format";
      error = "The synthetic source needs a size of at least 2x2 and a positive frame rate.";
      return false;
    }
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
    // One buffer for all frames: the sink only borrows the planes for the call.
    const size_t lumaSize = static_cast<size_t>(width_) * height_;
    std::vector<uint8_t> pixels(lumaSize + lumaSize / 2);
    while (running_.load()) {
      paint(pixels.data(), pixels.data() + lumaSize, index);
      CapturedFrame frame;
      frame.planes[0] = FramePlane{pixels.data(), width_, height_};
      frame.planes[1] = FramePlane{pixels.data() + lumaSize, width_, height_ / 2};
      frame.planeCount = 2;
      frame.width = width_;
      frame.height = height_;
      frame.pixelFormat = "nv12";
      frame.captureNs = monotonicNowNs();
      sink_(frame);
      ++index;
      next += period;
      std::this_thread::sleep_until(next);
    }
  }

  void paint(uint8_t *y, uint8_t *uv, uint64_t index) const {
    // SMPTE-like bars: (Y, U, V) per column band.
    static const uint8_t BARS[8][3] = {{235, 128, 128}, {210, 16, 146}, {170, 166, 16}, {145, 54, 34},
                                       {106, 202, 222}, {81, 90, 240}, {41, 240, 110}, {16, 128, 128}};
    const uint32_t band = std::max<uint32_t>(width_ / 8, 1);
    const uint32_t blockX = static_cast<uint32_t>((index * 8) % std::max<uint64_t>(width_ > 64 ? width_ - 64 : 1, 1));
    for (uint32_t row = 0; row < height_; ++row) {
      uint8_t *yRow = y + static_cast<size_t>(row) * width_;
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
        uint8_t *uvRow = uv + static_cast<size_t>(row / 2) * width_;
        for (uint32_t col = 0; col < width_; col += 2) {
          const uint8_t *bar = BARS[std::min<uint32_t>(col / band, 7)];
          uvRow[col] = bar[1];
          uvRow[col + 1] = bar[2];
        }
      }
    }
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
