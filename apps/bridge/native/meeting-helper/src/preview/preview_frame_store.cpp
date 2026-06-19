#include "preview/preview_frame_store.h"

namespace broadify::meeting {

void PreviewFrameStore::publish(uint32_t width, uint32_t height, const uint8_t *rgba, size_t rgbaSize) {
  if (width == 0u || height == 0u || rgba == nullptr || rgbaSize != static_cast<size_t>(width) * height * 4u) {
    return;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  frame_.width = width;
  frame_.height = height;
  frame_.rgba.assign(rgba, rgba + rgbaSize);
  ++frame_.sequence;
}

void PreviewFrameStore::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  frame_.width = 0u;
  frame_.height = 0u;
  frame_.rgba.clear();
  ++frame_.sequence;
}

bool PreviewFrameStore::copyLatest(PreviewFrame &frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (frame_.rgba.empty()) {
    return false;
  }
  frame = frame_;
  return true;
}

}  // namespace broadify::meeting
