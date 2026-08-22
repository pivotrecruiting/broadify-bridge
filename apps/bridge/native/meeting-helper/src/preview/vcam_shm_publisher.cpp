#include "preview/vcam_shm_publisher.h"

#include <chrono>
#include <cstring>

namespace broadify::meeting {

#if defined(_WIN32)

VcamShmPublisher::VcamShmPublisher() = default;

VcamShmPublisher::~VcamShmPublisher() { stop(); }

void VcamShmPublisher::start(VcamShmRingWin *ring) {
  stop();
  if (ring == nullptr || !ring->active()) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    ring_ = ring;
    pendingIndex_ = -1;
    busyIndex_ = -1;
    nextWriteIndex_ = 0;
    running_ = true;
  }
  thread_ = std::thread(&VcamShmPublisher::run, this);
}

void VcamShmPublisher::stop() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ && !thread_.joinable()) {
      ring_ = nullptr;
      pendingIndex_ = -1;
      busyIndex_ = -1;
      return;
    }
    running_ = false;
    pendingIndex_ = -1;
  }
  cv_.notify_all();
  if (thread_.joinable()) {
    thread_.join();
  }
  std::lock_guard<std::mutex> lock(mutex_);
  ring_ = nullptr;
  busyIndex_ = -1;
}

bool VcamShmPublisher::submitRgba(uint32_t width,
                                  uint32_t height,
                                  const uint8_t *rgba,
                                  size_t rgbaSize,
                                  uint64_t captureQpc) {
  const size_t expected = static_cast<size_t>(width) * height * 4u;
  if (width == 0u || height == 0u || rgba == nullptr || rgbaSize != expected) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_ || ring_ == nullptr || !ring_->active()) {
    return false;
  }
  int writeIndex = pendingIndex_;
  if (writeIndex >= 0) {
    droppedFrames_.fetch_add(1u, std::memory_order_relaxed);
  } else {
    writeIndex = nextWriteIndex_;
    if (writeIndex == busyIndex_) {
      writeIndex = 1 - writeIndex;
    }
  }
  BufferedFrame &frame = buffers_[static_cast<size_t>(writeIndex)];
  frame.width = width;
  frame.height = height;
  frame.captureQpc = captureQpc;
  frame.rgba.resize(rgbaSize);
  std::memcpy(frame.rgba.data(), rgba, rgbaSize);
  pendingIndex_ = writeIndex;
  nextWriteIndex_ = 1 - writeIndex;
  cv_.notify_one();
  return true;
}

VcamShmPublisherMetrics VcamShmPublisher::metrics() const {
  VcamShmPublisherMetrics snapshot;
  snapshot.droppedFrames = droppedFrames_.load(std::memory_order_relaxed);
  const uint64_t micros = publishMicros_.load(std::memory_order_relaxed);
  snapshot.publishMs =
      micros == 0u ? -1.0 : static_cast<double>(micros) / 1000.0;
  return snapshot;
}

void VcamShmPublisher::setPublishDelayForTesting(
    std::chrono::milliseconds delay) {
  std::lock_guard<std::mutex> lock(mutex_);
  publishDelayForTesting_ = delay;
}

void VcamShmPublisher::run() {
  for (;;) {
    int frameIndex = -1;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return !running_ || pendingIndex_ >= 0; });
      if (!running_ && pendingIndex_ < 0) {
        break;
      }
      frameIndex = pendingIndex_;
      pendingIndex_ = -1;
      busyIndex_ = frameIndex;
    }

    uint32_t width = 0u;
    uint32_t height = 0u;
    uint64_t captureQpc = 0u;
    const uint8_t *rgba = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const BufferedFrame &frame = buffers_[static_cast<size_t>(frameIndex)];
      width = frame.width;
      height = frame.height;
      captureQpc = frame.captureQpc;
      rgba = frame.rgba.data();
    }
    const auto start = std::chrono::steady_clock::now();
    VcamShmRingWin *ring = nullptr;
    std::chrono::milliseconds publishDelay{0};
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ring = ring_;
      publishDelay = publishDelayForTesting_;
    }
    if (publishDelay.count() > 0) {
      std::this_thread::sleep_for(publishDelay);
    }
    if (ring != nullptr && ring->active()) {
      ring->publishRgbaAsBgra(width, height, rgba,
                              static_cast<size_t>(width) * 4u, captureQpc);
    }
    const auto end = std::chrono::steady_clock::now();
    publishMicros_.store(
        static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(end - start)
                .count()),
        std::memory_order_relaxed);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (busyIndex_ == frameIndex) {
        busyIndex_ = -1;
      }
    }
  }
}

#endif

}  // namespace broadify::meeting
