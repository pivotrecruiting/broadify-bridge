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
#include <sddl.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cwchar>
#include <sstream>
#include <utility>

namespace broadify::vcam {
namespace {

constexpr uint64_t kMappingRetryMs = 5000u;
constexpr uint64_t kNoFrameFallbackMs = 2000u;
constexpr uint64_t kStaleWindowMs = 3000u;
constexpr DWORD kEventWaitMs = 1000u;

uint64_t nowMs() { return GetTickCount64(); }

uint64_t nowQpc() {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return value.QuadPart < 0 ? 0u : static_cast<uint64_t>(value.QuadPart);
}

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

class SecurityAttributes {
 public:
  explicit SecurityAttributes(const std::wstring &sddl) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
      descriptor_ = descriptor;
      attributes_.nLength = sizeof(attributes_);
      attributes_.lpSecurityDescriptor = descriptor_;
      attributes_.bInheritHandle = FALSE;
    }
  }

  ~SecurityAttributes() {
    if (descriptor_ != nullptr) {
      LocalFree(descriptor_);
    }
  }

  SECURITY_ATTRIBUTES *get() {
    return descriptor_ == nullptr ? nullptr : &attributes_;
  }

 private:
  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_{};
};

void logCreateFailed(DWORD error) {
  VcamLog("vcam_shm_owner service create_failed error=%lu", error);
}

void logOwnerOutcome(std::string &lastOutcome,
                     const std::string &outcome,
                     DWORD error = ERROR_SUCCESS) {
  if (lastOutcome == outcome) {
    return;
  }
  if (outcome == "create_failed") {
    logCreateFailed(error);
  } else {
    VcamLog("vcam_shm_owner service %s", outcome.c_str());
  }
  lastOutcome = outcome;
}

}  // namespace

ShmFrameReader::ShmFrameReader() = default;

ShmFrameReader::~ShmFrameReader() { stop(); }

bool ShmFrameReader::NoFrameDeadlineExpired(bool hasFrame,
                                            uint64_t openedAtMs,
                                            uint64_t currentMs) {
  return !hasFrame && openedAtMs != 0u &&
         currentMs >= openedAtMs + kNoFrameFallbackMs;
}

bool ShmFrameReader::ProbeGeometry(ShmGeometry &geometry) {
  HANDLE control = nullptr;
  void *view = nullptr;
  broadify::vcam_shm::ControlRecord record;
  if (!readGlobalControl(record, control, view, FILE_MAP_READ)) {
    return false;
  }
  const bool validControl = broadify::vcam_shm::validateServiceControl(record);
  if (!validControl) {
    UnmapViewOfFile(view);
    CloseHandle(control);
    return false;
  }
  geometry.width =
      std::min(record.width, broadify::vcam_shm::kMaxServiceWidth);
  geometry.height =
      std::min(record.height, broadify::vcam_shm::kMaxServiceHeight);
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
  closeServiceRing();
}

bool ShmFrameReader::createServiceRing() {
  if (ownerMappingMemory_ != nullptr && ownerControlMemory_ != nullptr &&
      ownerEventHandle_ != nullptr) {
    return true;
  }
  closeServiceRing();
  ownerRingBytes_ = broadify::vcam_shm::maxServiceRingBytes();
  if (ownerRingBytes_ == 0u) {
    logOwnerOutcome(ownerLogOutcome_, "create_failed", ERROR_INVALID_PARAMETER);
    return false;
  }

  SecurityAttributes security(broadify::vcam_shm::streamSecurityDescriptorSddl());
  LARGE_INTEGER size{};
  size.QuadPart = static_cast<LONGLONG>(ownerRingBytes_);
  const std::wstring streamName = broadify::vcam_shm::serviceStreamMappingName(true);
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, size.HighPart,
      size.LowPart, streamName.c_str());
  if (mapping == nullptr) {
    const DWORD error = GetLastError();
    logOwnerOutcome(ownerLogOutcome_, "create_failed", error);
    ownerRingBytes_ = 0u;
    return false;
  }
  const bool streamAlreadyExisted = GetLastError() == ERROR_ALREADY_EXISTS;

  const std::wstring eventName = broadify::vcam_shm::serviceStreamEventName(true);
  HANDLE event = CreateEventW(security.get(), FALSE, FALSE, eventName.c_str());
  if (event == nullptr) {
    const DWORD error = GetLastError();
    CloseHandle(mapping);
    logOwnerOutcome(ownerLogOutcome_, "create_failed", error);
    ownerRingBytes_ = 0u;
    return false;
  }

  const std::wstring controlName = broadify::vcam_shm::controlMappingName(true);
  HANDLE control = CreateFileMappingW(
      INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, 0,
      static_cast<DWORD>(sizeof(broadify::vcam_shm::ControlRecord)),
      controlName.c_str());
  if (control == nullptr) {
    const DWORD error = GetLastError();
    CloseHandle(event);
    CloseHandle(mapping);
    logOwnerOutcome(ownerLogOutcome_, "create_failed", error);
    ownerRingBytes_ = 0u;
    return false;
  }
  const bool controlAlreadyExisted = GetLastError() == ERROR_ALREADY_EXISTS;

  void *mappingView =
      MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, ownerRingBytes_);
  void *controlView = MapViewOfFile(
      control, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
      sizeof(broadify::vcam_shm::ControlRecord));
  if (mappingView == nullptr || controlView == nullptr) {
    const DWORD error = GetLastError();
    if (mappingView != nullptr) {
      UnmapViewOfFile(mappingView);
    }
    if (controlView != nullptr) {
      UnmapViewOfFile(controlView);
    }
    CloseHandle(control);
    CloseHandle(event);
    CloseHandle(mapping);
    logOwnerOutcome(ownerLogOutcome_, "create_failed", error);
    ownerRingBytes_ = 0u;
    return false;
  }

  ownerMappingHandle_ = mapping;
  ownerMappingMemory_ = mappingView;
  ownerEventHandle_ = event;
  ownerControlHandle_ = control;
  ownerControlMemory_ = controlView;

  const bool openedExisting = streamAlreadyExisted || controlAlreadyExisted;
  bool initialized = false;
  if (!openedExisting) {
    initialized = broadify::vcam_shm::initializeServiceRing(
        ownerMappingMemory_, ownerRingBytes_, nowQpc());
    auto *record =
        static_cast<broadify::vcam_shm::ControlRecord *>(ownerControlMemory_);
    *record = broadify::vcam_shm::ControlRecord{};
    record->magic = broadify::vcam_shm::kControlMagic;
    record->version = broadify::vcam_shm::kLayoutVersion;
    record->owner =
        static_cast<uint32_t>(broadify::vcam_shm::LayoutOwner::Service);
    record->capacity_bytes = ownerRingBytes_;
    std::wcsncpy(record->mapping_name, streamName.c_str(),
                 broadify::vcam_shm::kMaxNameChars - 1u);
    std::wcsncpy(record->event_name, eventName.c_str(),
                 broadify::vcam_shm::kMaxNameChars - 1u);
    std::atomic_thread_fence(std::memory_order_release);
    *reinterpret_cast<volatile uint64_t *>(&record->sequence) = 2u;
  } else {
    initialized = broadify::vcam_shm::validateServiceRing(
        ownerMappingMemory_, ownerRingBytes_);
    const auto *record =
        static_cast<const broadify::vcam_shm::ControlRecord *>(ownerControlMemory_);
    broadify::vcam_shm::ControlRecord snapshot;
    initialized = initialized &&
                  broadify::vcam_shm::readControlRecord(*record, snapshot) &&
                  broadify::vcam_shm::validateServiceControl(snapshot);
  }
  if (!initialized) {
    closeServiceRing();
    logOwnerOutcome(ownerLogOutcome_, "create_failed", ERROR_INVALID_DATA);
    return false;
  }
  logOwnerOutcome(ownerLogOutcome_,
                  openedExisting ? "opened_existing" : "created");
  return true;
}

void ShmFrameReader::closeServiceRing() {
  if (ownerEventHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(ownerEventHandle_));
  }
  if (ownerMappingMemory_ != nullptr) {
    UnmapViewOfFile(ownerMappingMemory_);
  }
  if (ownerMappingHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(ownerMappingHandle_));
  }
  if (ownerControlMemory_ != nullptr) {
    UnmapViewOfFile(ownerControlMemory_);
  }
  if (ownerControlHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(ownerControlHandle_));
  }
  ownerEventHandle_ = nullptr;
  ownerMappingMemory_ = nullptr;
  ownerMappingHandle_ = nullptr;
  ownerControlMemory_ = nullptr;
  ownerControlHandle_ = nullptr;
  ownerRingBytes_ = 0u;
}

bool ShmFrameReader::copyLatestIfNew(uint64_t lastSequence, RawFrame &out) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (mappingMemory_ == nullptr) {
    return false;
  }
  broadify::vcam_shm::FrameView frame;
  if (!broadify::vcam_shm::copyNewestFrameInto(mappingMemory_, ringBytes_,
                                               frame, out.bgra) &&
      !broadify::vcam_shm::copyNewestFrameInto(mappingMemory_, ringBytes_,
                                               frame, out.bgra)) {
    return false;
  }
  if (frame.format != broadify::vcam_shm::PixelFormat::Bgra8 ||
      frame.sequence == lastSequence) {
    return false;
  }
  out.width = frame.width;
  out.height = frame.height;
  out.sequence = frame.sequence;
  out.captureNs = frame.capture_qpc;
  hasFrame_ = true;
  lastArrivalMs_ = nowMs();
  observedSequence_ = frame.sequence;
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

uint64_t ShmFrameReader::mappingGeneration() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return openGeneration_;
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
  if (!broadify::vcam_shm::validateServiceControl(record)) {
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "invalid_control_record";
    return false;
  }
  if (record.width == 0u || record.height == 0u ||
      record.writer_generation == 0u) {
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "control_mapping_absent";
    return false;
  }

  mappingName_ = boundedWideString(record.mapping_name,
                                   broadify::vcam_shm::kMaxNameChars);
  eventName_ = boundedWideString(record.event_name,
                                 broadify::vcam_shm::kMaxNameChars);
  ringBytes_ = static_cast<size_t>(record.capacity_bytes);
  if (mappingName_.empty() || eventName_.empty() ||
      ringBytes_ < broadify::vcam_shm::maxServiceRingBytes()) {
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
  if (!broadify::vcam_shm::validateServiceRing(mappingView, ringBytes_)) {
    UnmapViewOfFile(mappingView);
    CloseHandle(mapping);
    UnmapViewOfFile(controlView);
    CloseHandle(control);
    reason = "invalid_stream_header";
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

  {
    std::lock_guard<std::mutex> lock(mutex_);
    controlHandle_ = control;
    controlMemory_ = controlView;
    mappingHandle_ = mapping;
    mappingMemory_ = mappingView;
    eventHandle_ = event;
    writerGeneration_ = record.writer_generation;
    openedAtMs_ = nowMs();
    mappingOpen_ = true;
    ++openGeneration_;
  }
  updateReaderLiveness();
  VcamLog("ShmFrameReader: opened %ls", mappingName_.c_str());
  return true;
}

void ShmFrameReader::closeMappings() {
  std::lock_guard<std::mutex> lock(mutex_);
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
  observedSequence_ = 0u;
  writerGeneration_ = 0u;
  openedAtMs_ = 0u;
  mappingOpen_ = false;
  hasFrame_ = false;
}

bool ShmFrameReader::observeNewestLocked() {
  std::lock_guard<std::mutex> lock(mutex_);
  broadify::vcam_shm::FrameView frame;
  if (!broadify::vcam_shm::peekNewestFrame(mappingMemory_, ringBytes_, frame) ||
      frame.format != broadify::vcam_shm::PixelFormat::Bgra8 ||
      frame.size != broadify::vcam_shm::bytesPerFrame(
                        frame.width, frame.height, frame.format) ||
      frame.sequence == observedSequence_) {
    return false;
  }
  hasFrame_ = true;
  lastArrivalMs_ = nowMs();
  observedSequence_ = frame.sequence;
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
    observeNewestLocked();
    const DWORD waitResult =
        WaitForSingleObject(static_cast<HANDLE>(eventHandle_), kEventWaitMs);
    if (!running_.load()) {
      break;
    }
    if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_TIMEOUT) {
      updateReaderLiveness();
      observeNewestLocked();
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
    bool noFrameDeadlineExpired = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      noFrameDeadlineExpired =
          NoFrameDeadlineExpired(hasFrame_, openedAtMs_, nowMs());
    }
    if (noFrameDeadlineExpired) {
      VcamLog("vcam_reader_transport tcp reason=shm_no_frame_after_open");
      closeMappings();
      nextRetryMs = nowMs() + kMappingRetryMs;
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
