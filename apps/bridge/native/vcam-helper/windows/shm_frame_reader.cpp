#include "shm_frame_reader.h"

#include "preview/vcam_shm_layout.h"
#include "vcam_log.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <utility>

namespace broadify::vcam {
namespace {

constexpr uint64_t kMappingRetryMs = 5000u;
constexpr uint64_t kStaleWindowMs = 3000u;
constexpr DWORD kEventWaitMs = 1000u;

uint64_t nowMs() { return GetTickCount64(); }

uint64_t loadAcquire(const uint64_t &value) {
  const uint64_t loaded = *reinterpret_cast<const volatile uint64_t *>(&value);
  std::atomic_thread_fence(std::memory_order_acquire);
  return loaded;
}

std::wstring boundedWideString(const wchar_t *value, size_t capacity) {
  size_t len = 0;
  while (len < capacity && value[len] != L'\0') {
    ++len;
  }
  return std::wstring(value, len);
}

bool readGlobalControl(broadify::vcam_shm::ControlRecord &record,
                       HANDLE &control,
                       void *&view,
                       DWORD desiredAccess) {
  const std::wstring name = broadify::vcam_shm::controlMappingName(true);
  control = OpenFileMappingW(desiredAccess, FALSE, name.c_str());
  if (control == nullptr) {
    return false;
  }
  view = MapViewOfFile(control, desiredAccess, 0, 0,
                       sizeof(broadify::vcam_shm::ControlRecord));
  if (view == nullptr) {
    CloseHandle(control);
    control = nullptr;
    return false;
  }
  const auto *current =
      static_cast<const broadify::vcam_shm::ControlRecord *>(view);
  if (!broadify::vcam_shm::readControlRecord(*current, record)) {
    UnmapViewOfFile(view);
    CloseHandle(control);
    view = nullptr;
    control = nullptr;
    return false;
  }
  return true;
}

}  // namespace

ShmFrameReader::ShmFrameReader() = default;

ShmFrameReader::~ShmFrameReader() { stop(); }

bool ShmFrameReader::ProbeGeometry(ShmGeometry &geometry) {
  HANDLE control = nullptr;
  void *view = nullptr;
  broadify::vcam_shm::ControlRecord record;
  if (!readGlobalControl(record, control, view, FILE_MAP_READ)) {
    return false;
  }
  geometry.width = record.width;
  geometry.height = record.height;
  geometry.fpsNum = record.fps_num == 0u ? 30u : record.fps_num;
  geometry.fpsDen = record.fps_den == 0u ? 1u : record.fps_den;
  UnmapViewOfFile(view);
  CloseHandle(control);
  return geometry.width > 0u && geometry.height > 0u;
}

void ShmFrameReader::start() {
  if (running_.exchange(true)) {
    return;
  }
  thread_ = std::thread(&ShmFrameReader::run, this);
}

void ShmFrameReader::stop() {
  if (!running_.exchange(false)) {
    return;
  }
  if (thread_.joinable()) {
    thread_.join();
  }
  closeMappings();
}

bool ShmFrameReader::copyLatestIfNew(uint64_t lastSequence, RawFrame &out) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_ || latest_.sequence == lastSequence) {
    return false;
  }
  out = latest_;
  return true;
}

uint64_t ShmFrameReader::staleAgeMs() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_) {
    return UINT64_MAX;
  }
  return nowMs() - lastArrivalMs_;
}

bool ShmFrameReader::hasMapping() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return mappingOpen_;
}

void ShmFrameReader::updateReaderLiveness() {
  if (controlMemory_ == nullptr) {
    return;
  }
  auto *record =
      static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory_);
  LARGE_INTEGER now{};
  QueryPerformanceCounter(&now);
  broadify::vcam_shm::updateReaderSlot(
      *record, GetCurrentProcessId(), static_cast<uint64_t>(now.QuadPart));
}

void ShmFrameReader::clearReaderLiveness() {
  if (controlMemory_ == nullptr) {
    return;
  }
  auto *record =
      static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory_);
  broadify::vcam_shm::clearReaderSlot(*record, GetCurrentProcessId());
}

bool ShmFrameReader::writerGenerationChanged() const {
  if (controlMemory_ == nullptr || writerGeneration_ == 0u) {
    return false;
  }
  const auto *record =
      static_cast<const broadify::vcam_shm::ControlRecord *>(controlMemory_);
  broadify::vcam_shm::ControlRecord current;
  return broadify::vcam_shm::readControlRecord(*record, current) &&
         current.writer_generation != writerGeneration_;
}

bool ShmFrameReader::openFromControl(std::string &reason) {
  closeMappings();
  HANDLE control = nullptr;
  void *controlView = nullptr;
  broadify::vcam_shm::ControlRecord record;
  if (!readGlobalControl(record, control, controlView,
                         FILE_MAP_READ | FILE_MAP_WRITE)) {
    reason = "control_mapping_absent";
    return false;
  }

  mappingName_ = boundedWideString(record.mapping_name,
                                   broadify::vcam_shm::kMaxNameChars);
  eventName_ = boundedWideString(record.event_name,
                                 broadify::vcam_shm::kMaxNameChars);
  ringBytes_ = broadify::vcam_shm::ringBytesFor(
      record.width, record.height,
      static_cast<broadify::vcam_shm::PixelFormat>(record.format));
  if (mappingName_.empty() || eventName_.empty() || ringBytes_ == 0u) {
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "invalid_control_record";
    return false;
  }

  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName_.c_str());
  if (mapping == nullptr) {
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "stream_mapping_absent";
    return false;
  }
  void *mappingView = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, ringBytes_);
  if (mappingView == nullptr) {
    CloseHandle(mapping);
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "stream_mapping_unreadable";
    return false;
  }
  HANDLE event = OpenEventW(SYNCHRONIZE, FALSE, eventName_.c_str());
  if (event == nullptr) {
    UnmapViewOfFile(mappingView);
    CloseHandle(mapping);
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "frame_event_absent";
    return false;
  }

  controlHandle_ = control;
  controlMemory_ = controlView;
  mappingHandle_ = mapping;
  mappingMemory_ = mappingView;
  eventHandle_ = event;
  writerGeneration_ = record.writer_generation;
  updateReaderLiveness();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    mappingOpen_ = true;
  }
  VcamLog("ShmFrameReader: opened %ls", mappingName_.c_str());
  return true;
}

void ShmFrameReader::closeMappings() {
  clearReaderLiveness();
  if (eventHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(eventHandle_));
  }
  if (mappingMemory_ != nullptr) {
    UnmapViewOfFile(mappingMemory_);
  }
  if (mappingHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(mappingHandle_));
  }
  if (controlMemory_ != nullptr) {
    UnmapViewOfFile(controlMemory_);
  }
  if (controlHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(controlHandle_));
  }
  eventHandle_ = nullptr;
  mappingMemory_ = nullptr;
  mappingHandle_ = nullptr;
  controlMemory_ = nullptr;
  controlHandle_ = nullptr;
  ringBytes_ = 0u;
  lastSequence_ = 0u;
  writerGeneration_ = 0u;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    mappingOpen_ = false;
  }
}

bool ShmFrameReader::copyNewestLocked() {
  broadify::vcam_shm::CopiedFrame frame;
  if (!broadify::vcam_shm::copyNewestFrame(mappingMemory_, ringBytes_, frame) ||
      frame.format != broadify::vcam_shm::PixelFormat::Bgra8 ||
      frame.sequence == lastSequence_) {
    return false;
  }
  RawFrame next;
  next.width = frame.width;
  next.height = frame.height;
  next.sequence = frame.sequence;
  next.captureNs = frame.capture_qpc;
  next.bgra = std::move(frame.data);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    latest_ = std::move(next);
    hasFrame_ = true;
    lastArrivalMs_ = nowMs();
  }
  lastSequence_ = frame.sequence;
  return true;
}

bool ShmFrameReader::heartbeatStale() const {
  if (mappingMemory_ == nullptr) {
    return true;
  }
  const auto *header =
      broadify::vcam_shm::ringHeader(mappingMemory_, ringBytes_);
  const uint64_t heartbeatQpc =
      header == nullptr ? 0u : loadAcquire(header->heartbeat_qpc);
  if (header == nullptr || heartbeatQpc == 0u) {
    return true;
  }
  LARGE_INTEGER now{};
  LARGE_INTEGER frequency{};
  QueryPerformanceCounter(&now);
  QueryPerformanceFrequency(&frequency);
  if (frequency.QuadPart <= 0 || now.QuadPart < 0) {
    return true;
  }
  const uint64_t nowQpc = static_cast<uint64_t>(now.QuadPart);
  const uint64_t staleTicks =
      (static_cast<uint64_t>(frequency.QuadPart) * kStaleWindowMs) / 1000u;
  return nowQpc > heartbeatQpc + staleTicks;
}

void ShmFrameReader::run() {
  uint64_t nextRetryMs = 0u;
  std::string lastReason;
  while (running_.load()) {
    if (mappingMemory_ == nullptr) {
      const uint64_t now = nowMs();
      if (now < nextRetryMs) {
        Sleep(100);
        continue;
      }
      std::string reason;
      if (!openFromControl(reason)) {
        if (reason != lastReason) {
          VcamLog("vcam_reader_transport tcp reason=%s", reason.c_str());
          lastReason = reason;
        }
        nextRetryMs = now + kMappingRetryMs;
        continue;
      }
      lastReason.clear();
    }

    updateReaderLiveness();
    copyNewestLocked();
    const DWORD waitResult =
        WaitForSingleObject(static_cast<HANDLE>(eventHandle_), kEventWaitMs);
    if (!running_.load()) {
      break;
    }
    if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_TIMEOUT) {
      updateReaderLiveness();
      copyNewestLocked();
    } else {
      VcamLog("ShmFrameReader: event wait failed error=%lu", GetLastError());
      closeMappings();
      nextRetryMs = nowMs() + kMappingRetryMs;
      continue;
    }
    if (writerGenerationChanged()) {
      VcamLog("vcam_reader_transport tcp reason=shm_generation_changed");
      closeMappings();
      nextRetryMs = 0u;
      continue;
    }
    if (heartbeatStale()) {
      VcamLog("vcam_reader_transport tcp reason=shm_heartbeat_stale");
      closeMappings();
      nextRetryMs = nowMs() + kMappingRetryMs;
    }
  }
}

}  // namespace broadify::vcam
