#pragma once

#include "preview/vcam_shm_layout.h"

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>

namespace broadify::meeting {

struct VcamShmCreateResult {
  bool ok = false;
  bool globalNamespace = false;
  std::string reason;
};

class VcamShmRingWin {
 public:
  VcamShmRingWin();
  ~VcamShmRingWin();

  VcamShmRingWin(const VcamShmRingWin &) = delete;
  VcamShmRingWin &operator=(const VcamShmRingWin &) = delete;

  VcamShmCreateResult create(uint32_t width,
                             uint32_t height,
                             uint32_t fps,
                             uint64_t writerGeneration);
  VcamShmCreateResult createWithControlName(uint32_t width,
                                            uint32_t height,
                                            uint32_t fps,
                                            uint64_t writerGeneration,
                                            const std::wstring &controlName,
                                            bool globalNamespace = true);
  VcamShmCreateResult openServiceRing(uint32_t width,
                                      uint32_t height,
                                      uint32_t fps,
                                      uint64_t writerGeneration,
                                      bool globalNamespace = true);
  void close();

  bool publishBgra(uint32_t width,
                   uint32_t height,
                   const uint8_t *bgra,
                   size_t bgraSize,
                   uint64_t captureQpc);
  bool publishRgbaAsBgra(uint32_t width,
                         uint32_t height,
                         const uint8_t *rgba,
                         size_t rgbaStride,
                         uint64_t captureQpc);
  bool heartbeat(uint64_t heartbeatQpc);
  uint64_t readerCount() const;
  bool readerHeartbeatAbsent(uint64_t staleMs) const;

  bool active() const;
  const std::wstring &mappingName() const { return mappingName_; }
  const std::wstring &eventName() const { return eventName_; }

 private:
  void closeLocked();
  bool createWithNamespace(bool globalNamespace,
                           uint32_t width,
                           uint32_t height,
                           uint32_t fps,
                           uint64_t writerGeneration,
                           std::string &reason);
  bool openServiceRingLocked(uint32_t width,
                             uint32_t height,
                             uint32_t fps,
                             uint64_t writerGeneration,
                             bool globalNamespace,
                             std::string &reason);

  mutable std::mutex mutex_;
  void *mappingHandle_ = nullptr;
  void *eventHandle_ = nullptr;
  void *controlHandle_ = nullptr;
  void *memory_ = nullptr;
  void *controlMemory_ = nullptr;
  size_t ringBytes_ = 0;
  uint64_t nextSequence_ = 1;
  uint64_t lastFrameTimestampQpc_ = 0;
  std::wstring token_;
  std::wstring mappingName_;
  std::wstring eventName_;
  std::wstring controlName_;
};

}  // namespace broadify::meeting
