#pragma once

#include "raw_frame_client.h"

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace broadify::vcam {

struct ShmGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fpsNum = 30;
  uint32_t fpsDen = 1;
};

class ShmFrameReader {
 public:
  ShmFrameReader();
  ~ShmFrameReader();

  ShmFrameReader(const ShmFrameReader &) = delete;
  ShmFrameReader &operator=(const ShmFrameReader &) = delete;

  static bool ProbeGeometry(ShmGeometry &geometry);

  void start();
  void stop();

  bool copyLatestIfNew(uint64_t lastSequence, RawFrame &out) const;
  uint64_t staleAgeMs() const;
  bool hasMapping() const;

 private:
  void run();
  bool openFromControl(std::string &reason);
  void closeMappings();
  bool copyNewestLocked();
  bool heartbeatStale() const;
  void updateReaderLiveness();
  void clearReaderLiveness();
  bool writerGenerationChanged() const;

  std::atomic<bool> running_{false};
  std::thread thread_;

  mutable std::mutex mutex_;
  bool hasFrame_ = false;
  RawFrame latest_;
  uint64_t lastArrivalMs_ = 0;
  bool mappingOpen_ = false;
  std::wstring mappingName_;
  std::wstring eventName_;

  void *controlHandle_ = nullptr;
  void *controlMemory_ = nullptr;
  void *mappingHandle_ = nullptr;
  void *mappingMemory_ = nullptr;
  void *eventHandle_ = nullptr;
  size_t ringBytes_ = 0;
  uint64_t lastSequence_ = 0;
  uint64_t writerGeneration_ = 0;
};

}  // namespace broadify::vcam
