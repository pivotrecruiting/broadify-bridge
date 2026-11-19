// Snapshot path for platforms without a retainable platform buffer (Windows):
// the capture callback's planes are only valid inside the callback, so the
// frame kept for snapshots is a copy. macOS keeps the CVPixelBuffer instead
// (frame_holder_mac.mm, snapshot.mm).
#include "capture/frame_holder.h"
#include "capture/snapshot.h"
#include "capture/snapshot_portable.h"
#include "live_stream/monotonic_clock.h"
#include "live_stream/nv12_layout.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <vector>

namespace broadify::pgm {
namespace {

// A snapshot may be this old; copying every frame of a 1080p60 program would
// move ~190 MB/s for a picture that is asked for a few times per minute.
constexpr uint64_t kRetainIntervalNs = 200'000'000ULL;

// Bytes of one row that carry picture. A capture buffer may end with the
// visible part of its last row, so the copy must not read a full stride there.
size_t visibleRowBytes(const CapturedFrame &frame, uint32_t plane) {
  size_t visible = frame.planes[plane].stride;
  if (frame.pixelFormat == "nv12") {
    visible = plane == 0 ? frame.width : static_cast<size_t>(2) * nv12ChromaWidth(frame.width);
  } else if (frame.pixelFormat == "yuy2" || frame.pixelFormat == "uyvy") {
    visible = static_cast<size_t>(4) * nv12ChromaWidth(frame.width);
  } else if (frame.pixelFormat == "bgra" || frame.pixelFormat == "rgba") {
    visible = static_cast<size_t>(4) * frame.width;
  }
  return std::min<size_t>(visible, frame.planes[plane].stride);
}

class CopiedFrame final : public RetainedFrame {
 public:
  explicit CopiedFrame(const CapturedFrame &frame) : frame_(frame) {
    size_t total = 0;
    for (uint32_t plane = 0; plane < frame.planeCount; ++plane) {
      total += static_cast<size_t>(frame.planes[plane].stride) * frame.planes[plane].rows;
    }
    // Zero-filled: the padding the copy below leaves out is defined memory.
    pixels_.resize(total);
    size_t offset = 0;
    for (uint32_t plane = 0; plane < frame.planeCount; ++plane) {
      const FramePlane &source = frame.planes[plane];
      if (source.rows > 0) {
        const size_t size = static_cast<size_t>(source.stride) * (source.rows - 1) + visibleRowBytes(frame, plane);
        std::memcpy(pixels_.data() + offset, source.data, size);
      }
      frame_.planes[plane].data = pixels_.data() + offset;
      offset += static_cast<size_t>(source.stride) * source.rows;
    }
    // The platform sample is only borrowed for the capture callback.
    frame_.nativeHandle = nullptr;
  }

  const CapturedFrame &frame() const override { return frame_; }

 private:
  CapturedFrame frame_;
  std::vector<uint8_t> pixels_;
};

std::atomic<uint64_t> g_lastRetainNs{0};
std::atomic<uint64_t> g_lastGeometry{0};

}  // namespace

std::shared_ptr<const RetainedFrame> retainFrame(const CapturedFrame &frame) {
  if (frame.planeCount == 0 || frame.planeCount > 3) {
    return nullptr;
  }
  for (uint32_t plane = 0; plane < frame.planeCount; ++plane) {
    if (frame.planes[plane].data == nullptr) {
      return nullptr;
    }
  }
  // The engine keeps the previous frame when this returns nullptr; a new
  // geometry is copied at once so a snapshot never shows the old format.
  const uint64_t geometry = (static_cast<uint64_t>(frame.width) << 32) | frame.height;
  const uint64_t now = monotonicNowNs();
  const uint64_t last = g_lastRetainNs.load();
  if (g_lastGeometry.load() == geometry && last != 0 && now - last < kRetainIntervalNs) {
    return nullptr;
  }
  g_lastGeometry.store(geometry);
  g_lastRetainNs.store(now);
  return std::make_shared<CopiedFrame>(frame);
}

std::string jpegBase64FromFrame(const CapturedFrame &frame, double quality, uint32_t &outWidth, uint32_t &outHeight) {
  return jpegBase64FromPlanes(frame, quality, outWidth, outHeight);
}

}  // namespace broadify::pgm
