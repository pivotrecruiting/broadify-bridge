#pragma once

#include <cstdint>
#include <condition_variable>
#include <chrono>
#include <mutex>
#include <vector>

namespace broadify::meeting {

struct PreviewFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t sequence = 0;
  uint64_t captureNs = 0;
  std::vector<uint8_t> rgba;
};

class PreviewFrameStore {
 public:
  void publish(uint32_t width, uint32_t height, const uint8_t *rgba, size_t rgbaSize);
  void clear();
  bool copyLatest(PreviewFrame &frame) const;
  bool copyLatestIfNew(uint64_t lastSequence, PreviewFrame &frame) const;
  bool waitForNewFrame(uint64_t lastSequence,
                       std::chrono::steady_clock::time_point deadline) const;
  uint64_t sequence() const;

 private:
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
  PreviewFrame frame_;
};

}  // namespace broadify::meeting
