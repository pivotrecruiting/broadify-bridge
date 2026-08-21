#include "preview/preview_frame_store.h"

namespace broadify::meeting {

void PreviewFrameStore::publish(uint32_t width, uint32_t height, const uint8_t *rgba, size_t rgbaSize) {
  if (width == 0u || height == 0u || rgba == nullptr || rgbaSize != static_cast<size_t>(width) * height * 4u) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    frame_.width = width;
    frame_.height = height;
    frame_.rgba.assign(rgba, rgba + rgbaSize);
    ++frame_.sequence;
  }
  cv_.notify_all();
}

void PreviewFrameStore::clear() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    frame_.width = 0u;
    frame_.height = 0u;
    frame_.rgba.clear();
    ++frame_.sequence;
  }
  cv_.notify_all();
}

bool PreviewFrameStore::copyLatest(PreviewFrame &frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (frame_.rgba.empty()) {
    return false;
  }
  frame = frame_;
  return true;
}

bool PreviewFrameStore::copyLatestIfNew(uint64_t lastSequence, PreviewFrame &frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (frame_.rgba.empty() || frame_.sequence == lastSequence) {
    return false;
  }
  frame = frame_;
  return true;
}

bool PreviewFrameStore::waitForNewFrame(
    uint64_t lastSequence,
    std::chrono::steady_clock::time_point deadline) const {
  std::unique_lock<std::mutex> lock(mutex_);
  return cv_.wait_until(lock, deadline, [this, lastSequence] {
    return frame_.sequence != lastSequence;
  });
}

uint64_t PreviewFrameStore::sequence() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return frame_.sequence;
}

}  // namespace broadify::meeting
