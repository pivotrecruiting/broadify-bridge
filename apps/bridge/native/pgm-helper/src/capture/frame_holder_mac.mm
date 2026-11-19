#include "capture/frame_holder.h"

#include <CoreVideo/CoreVideo.h>

namespace broadify::pgm {
namespace {

class PixelBufferFrame final : public RetainedFrame {
 public:
  explicit PixelBufferFrame(const CapturedFrame &frame) : frame_(frame) {
    CFRetain(frame_.pixelBuffer);
    // The plane pointers and the native handle are only valid inside the capture callback.
    frame_.planeCount = 0;
    frame_.nativeHandle = nullptr;
  }
  ~PixelBufferFrame() override { CFRelease(frame_.pixelBuffer); }
  PixelBufferFrame(const PixelBufferFrame &) = delete;
  PixelBufferFrame &operator=(const PixelBufferFrame &) = delete;

  const CapturedFrame &frame() const override { return frame_; }

 private:
  CapturedFrame frame_;
};

}  // namespace

std::shared_ptr<const RetainedFrame> retainFrame(const CapturedFrame &frame) {
  if (frame.pixelBuffer == nullptr) {
    return nullptr;
  }
  return std::make_shared<PixelBufferFrame>(frame);
}

}  // namespace broadify::pgm
