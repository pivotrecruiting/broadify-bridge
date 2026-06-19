#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

namespace broadify::meeting {

struct PreviewFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t sequence = 0;
  std::vector<uint8_t> rgba;
};

class PreviewFrameStore {
 public:
  void publish(uint32_t width, uint32_t height, const uint8_t *rgba, size_t rgbaSize);
  void clear();
  bool copyLatest(PreviewFrame &frame) const;

 private:
  mutable std::mutex mutex_;
  PreviewFrame frame_;
};

}  // namespace broadify::meeting
