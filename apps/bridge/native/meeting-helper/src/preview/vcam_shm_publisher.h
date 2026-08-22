#pragma once

#include "preview/vcam_shm_ring_win.h"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

namespace broadify::meeting {

#if defined(_WIN32)

struct VcamShmPublisherMetrics {
  uint64_t droppedFrames = 0;
  double publishMs = -1.0;
};

class VcamShmPublisher {
 public:
  VcamShmPublisher();
  ~VcamShmPublisher();

  VcamShmPublisher(const VcamShmPublisher &) = delete;
  VcamShmPublisher &operator=(const VcamShmPublisher &) = delete;

  void start(VcamShmRingWin *ring);
  void stop();
  bool submitRgba(uint32_t width,
                  uint32_t height,
                  const uint8_t *rgba,
                  size_t rgbaSize,
                  uint64_t captureQpc);
  bool submitRgba(uint32_t width,
                  uint32_t height,
                  std::vector<uint8_t> &rgba,
                  uint64_t captureQpc);
  VcamShmPublisherMetrics metrics() const;
  void setPublishDelayForTesting(std::chrono::milliseconds delay);

 private:
  struct BufferedFrame {
    uint32_t width = 0;
    uint32_t height = 0;
    uint64_t captureQpc = 0;
    std::vector<uint8_t> rgba;
  };

  void run();
  void resetLocked();
  int reserveWriteBufferLocked(size_t rgbaSize);

  VcamShmRingWin *ring_ = nullptr;
  std::array<BufferedFrame, 3> buffers_;
  int pendingIndex_ = -1;
  int busyIndex_ = -1;
  int writingIndex_ = -1;
  int nextWriteIndex_ = 0;
  bool running_ = false;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
  std::atomic<uint64_t> droppedFrames_{0};
  std::atomic<uint64_t> publishMicros_{0};
  std::chrono::milliseconds publishDelayForTesting_{0};
};

#endif

}  // namespace broadify::meeting
