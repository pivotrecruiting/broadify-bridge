// NV12 frame converter of the program stream (Windows, ADR-0009): the Media
// Foundation encoder takes NV12 in system memory and neither converts nor
// scales, so the RGBA program frame is converted on the CPU with the BT.709
// limited-range module of live_stream_core.
//
// The result stays at the size of the program FRAME, in one buffer the
// converter keeps and reuses. The encoder's input stage copies it into its own
// pooled IMFSample and, when the encode target differs from the frame, scales
// it there with the NV12 scaler of live_stream_core. Nothing here calls Media
// Foundation and nothing is retained by the encoder after encode() returned,
// so one buffer is enough and release() has nothing to free.
//
// Pure C++ on purpose: the same file is driven by a ctest target on macOS.

#include "live/program_frame_converter.h"

#include "live_stream/nv12_layout.h"
#include "live_stream/rgba_to_nv12.h"
#include "preview/preview_frame_store.h"

#include <cstddef>
#include <limits>
#include <new>
#include <vector>

namespace broadify::meeting {

namespace {

class Nv12ProgramFrameConverter final : public ProgramFrameConverter {
 public:
  bool prepare(uint32_t width, uint32_t height) override {
    if (width == width_ && height == height_ && !buffer_.empty()) {
      return true;
    }
    reset();
    // The RGBA stride (4 * width) has to fit the 32-bit strides of the pixel modules.
    if (width == 0 || height == 0 || width > (std::numeric_limits<uint32_t>::max)() / 4) {
      failure_ = "The program frame size is empty or too large for the NV12 conversion.";
      return false;
    }
    // Contiguous NV12 at the visible stride; odd sizes round the chroma plane up.
    const uint32_t uvStride = 2 * live::nv12ChromaWidth(width);
    const size_t lumaSize = static_cast<size_t>(width) * height;
    const size_t chromaSize = static_cast<size_t>(uvStride) * live::nv12ChromaRows(height);
    try {
      buffer_.resize(lumaSize + chromaSize);
    } catch (const std::bad_alloc &) {
      buffer_ = std::vector<uint8_t>();
      failure_ = "No memory for the NV12 buffer of the program stream.";
      return false;
    }
    width_ = width;
    height_ = height;
    uvStride_ = uvStride;
    lumaSize_ = lumaSize;
    return true;
  }

  std::string failure() const override { return failure_; }

  bool convert(const PreviewFrame &frame, live::CapturedFrame &out) override {
    // Bounded by the prepared geometry: a frame of another size or with a short payload is refused, never clipped.
    if (buffer_.empty() || frame.width != width_ || frame.height != height_) {
      return false;
    }
    const size_t rgbaStride = static_cast<size_t>(width_) * 4;
    if (frame.rgba.size() < rgbaStride * height_) {
      return false;
    }
    uint8_t *luma = buffer_.data();
    uint8_t *chroma = buffer_.data() + lumaSize_;
    const live::Nv12Planes planes{luma, width_, chroma, uvStride_};
    if (!live::rgbaToNv12(frame.rgba.data(), static_cast<uint32_t>(rgbaStride), width_, height_, live::RgbaOrder::Rgba, planes)) {
      return false;
    }
    out.planes[0] = {luma, width_, height_};
    out.planes[1] = {chroma, uvStride_, live::nv12ChromaRows(height_)};
    out.planes[2] = {};
    out.planeCount = 2;
    out.nativeHandle = nullptr;
    out.width = width_;
    out.height = height_;
    out.pixelFormat = "nv12";
    return true;
  }

  void release(live::CapturedFrame &frame) override {
    // The planes point into the converter's buffer; the encoder copied them inside encode().
    frame.planes[0] = {};
    frame.planes[1] = {};
    frame.planeCount = 0;
  }

  void reset() override {
    buffer_ = std::vector<uint8_t>();
    width_ = 0;
    height_ = 0;
    uvStride_ = 0;
    lumaSize_ = 0;
  }

  bool runsUnderStoreLock() const override { return false; }

  // After `encoder_unavailable`: every attempt enumerates the hardware encoder
  // MFTs and activates each candidate on a new encoder thread.
  bool pacesEncoderRetries() const override { return true; }

 private:
  std::vector<uint8_t> buffer_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t uvStride_ = 0;
  size_t lumaSize_ = 0;
  std::string failure_;
};

}  // namespace

std::unique_ptr<ProgramFrameConverter> createProgramFrameConverter() {
  return std::make_unique<Nv12ProgramFrameConverter>();
}

}  // namespace broadify::meeting
