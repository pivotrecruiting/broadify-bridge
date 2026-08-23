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
  static bool NoFrameDeadlineExpired(bool hasFrame,
                                     uint64_t openedAtMs,
                                     uint64_t nowMs);
  static uint64_t RetryDelayMsForReason(const std::string &reason);

  void start();
  void stop();
  bool createServiceRing();
  void closeServiceRing();

  bool copyLatestIfNew(uint64_t lastSequence, RawFrame &out);
  uint64_t staleAgeMs() const;
  bool hasMapping() const;
  uint64_t mappingGeneration() const;

 private:
  void run();
  bool openFromControl(std::string &reason);
  void closeMappings();
  bool observeNewestLocked();
  bool heartbeatStale() const;
  void updateReaderLiveness();
  void clearReaderLiveness();
  bool writerGenerationChanged() const;

  std::atomic<bool> running_{false};
  std::thread thread_;

  mutable std::mutex mutex_;
  bool hasFrame_ = false;
  uint64_t lastArrivalMs_ = 0;
  bool mappingOpen_ = false;
  std::wstring mappingName_;
  std::wstring eventName_;

  void *controlHandle_ = nullptr;
  void *controlMemory_ = nullptr;
  void *mappingHandle_ = nullptr;
  void *mappingMemory_ = nullptr;
  void *eventHandle_ = nullptr;
  void *ownerControlHandle_ = nullptr;
  void *ownerControlMemory_ = nullptr;
  void *ownerMappingHandle_ = nullptr;
  void *ownerMappingMemory_ = nullptr;
  void *ownerEventHandle_ = nullptr;
  size_t ownerRingBytes_ = 0;
  std::string ownerLogOutcome_;
  size_t ringBytes_ = 0;
  uint64_t observedSequence_ = 0;
  uint64_t writerGeneration_ = 0;
  uint64_t openedAtMs_ = 0;
  uint64_t openGeneration_ = 0;
};

}  // namespace broadify::vcam
