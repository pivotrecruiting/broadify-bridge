#include "preview/vcam_shm_ring_win.h"

#include "util/helper_event_log.h"

#include <atomic>
#include <cstring>
#include <iostream>

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <aclapi.h>
#include <sddl.h>
#include <windows.h>

#include <sstream>

#pragma comment(lib, "advapi32.lib")

#endif

namespace broadify::meeting {
namespace {

uint64_t nowQpc() {
#if defined(_WIN32)
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return static_cast<uint64_t>(value.QuadPart);
#else
  return 0u;
#endif
}

#if defined(_WIN32)

std::string lastErrorText(const char *operation) {
  std::ostringstream out;
  out << operation << " failed error=" << GetLastError();
  return out.str();
}

std::string createMappingFailureReason(const char *operation,
                                       bool globalNamespace) {
  const DWORD error = GetLastError();
  if (globalNamespace && error == ERROR_ACCESS_DENIED) {
    return "global_namespace_privilege";
  }
  std::ostringstream out;
  out << operation << " failed error=" << error;
  return out.str();
}

uint64_t qpcStaleTicks(uint64_t staleMs) {
  LARGE_INTEGER frequency{};
  QueryPerformanceFrequency(&frequency);
  return frequency.QuadPart <= 0
             ? 0u
             : (static_cast<uint64_t>(frequency.QuadPart) * staleMs) / 1000u;
}

bool isProcessAlive(uint32_t pid) {
  if (pid == 0u) {
    return false;
  }
  // The reader is the Windows Frame Server (svchost, LOCAL SERVICE). A user
  // process may not get SYNCHRONIZE on it, so ask for the least privilege and
  // treat "access denied" as alive/unknown; only a non-existent pid is dead.
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                               static_cast<DWORD>(pid));
  if (process == nullptr) {
    return GetLastError() == ERROR_ACCESS_DENIED;
  }
  DWORD exitCode = 0;
  const BOOL ok = GetExitCodeProcess(process, &exitCode);
  CloseHandle(process);
  return ok && exitCode == STILL_ACTIVE;
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

struct OpenedRingResources {
  HANDLE mappingHandle = nullptr;
  HANDLE eventHandle = nullptr;
  HANDLE controlHandle = nullptr;
  void *memory = nullptr;
  void *controlMemory = nullptr;
  size_t ringBytes = 0u;
  std::wstring token;
  std::wstring mappingName;
  std::wstring eventName;
  std::wstring controlName;
};

void closeResources(OpenedRingResources &resources) {
  if (resources.memory != nullptr) {
    UnmapViewOfFile(resources.memory);
  }
  if (resources.controlMemory != nullptr) {
    UnmapViewOfFile(resources.controlMemory);
  }
  if (resources.mappingHandle != nullptr) {
    CloseHandle(resources.mappingHandle);
  }
  if (resources.eventHandle != nullptr) {
    CloseHandle(resources.eventHandle);
  }
  if (resources.controlHandle != nullptr) {
    CloseHandle(resources.controlHandle);
  }
  resources = OpenedRingResources{};
}

bool publishControlRecord(void *controlMemory,
                          const std::wstring &mappingName,
                          const std::wstring &eventName,
                          size_t ringBytes,
                          uint32_t width,
                          uint32_t height,
                          uint32_t fps,
                          uint64_t writerGeneration,
                          uint64_t heartbeatQpc) {
  if (controlMemory == nullptr) {
    return false;
  }
  broadify::vcam_shm::ControlRecord next;
  if (!broadify::vcam_shm::initializeControlRecord(
          next, mappingName, eventName, width, height, fps, 1u,
          broadify::vcam_shm::PixelFormat::Bgra8,
          static_cast<uint32_t>(GetCurrentProcessId()), writerGeneration,
          heartbeatQpc)) {
    return false;
  }
  next.owner = static_cast<uint32_t>(broadify::vcam_shm::LayoutOwner::Service);
  next.capacity_bytes = ringBytes;
  auto *record =
      static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory);
  return broadify::vcam_shm::writeControlRecord(*record, next);
}

#endif

}  // namespace

VcamShmRingWin::VcamShmRingWin() = default;

VcamShmRingWin::~VcamShmRingWin() { close(); }

VcamShmCreateResult VcamShmRingWin::create(uint32_t width,
                                           uint32_t height,
                                           uint32_t fps,
                                           uint64_t writerGeneration) {
  std::lock_guard<std::mutex> lock(mutex_);
  closeLocked();
#if defined(_WIN32)
  std::string reason;
  if (openServiceRingLocked(width, height, fps, writerGeneration, true, reason)) {
    return VcamShmCreateResult{true, true, "opened_service_ring"};
  }
  if (reason != "service_ring_absent") {
    return VcamShmCreateResult{false, false, reason};
  }
  if (createWithNamespace(true, width, height, fps, writerGeneration, reason)) {
    return VcamShmCreateResult{true, true, "created_global"};
  }
  return VcamShmCreateResult{false, false, reason};
#else
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  return VcamShmCreateResult{false, false, "shared memory transport is Windows-only"};
#endif
}

VcamShmCreateResult VcamShmRingWin::createWithControlName(
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    uint64_t writerGeneration,
    const std::wstring &controlName,
    bool globalNamespace) {
  std::lock_guard<std::mutex> lock(mutex_);
  closeLocked();
#if defined(_WIN32)
  std::string reason;
  controlName_ = controlName;
  if (createWithNamespace(globalNamespace, width, height, fps,
                          writerGeneration, reason)) {
    return VcamShmCreateResult{true, globalNamespace, "created_global"};
  }
  return VcamShmCreateResult{false, false, reason};
#else
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  (void)controlName;
  (void)globalNamespace;
  return VcamShmCreateResult{false, false, "shared memory transport is Windows-only"};
#endif
}

VcamShmCreateResult VcamShmRingWin::openServiceRing(uint32_t width,
                                                    uint32_t height,
                                                    uint32_t fps,
                                                    uint64_t writerGeneration,
                                                    bool globalNamespace) {
  std::lock_guard<std::mutex> lock(mutex_);
  closeLocked();
#if defined(_WIN32)
  std::string reason;
  if (openServiceRingLocked(width, height, fps, writerGeneration,
                            globalNamespace, reason)) {
    return VcamShmCreateResult{true, globalNamespace, "opened_service_ring"};
  }
  return VcamShmCreateResult{false, false, reason};
#else
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  (void)globalNamespace;
  return VcamShmCreateResult{false, false, "shared memory transport is Windows-only"};
#endif
}

void VcamShmRingWin::close() {
  std::lock_guard<std::mutex> lock(mutex_);
  closeLocked();
}

void VcamShmRingWin::closeLocked() {
#if defined(_WIN32)
  if (memory_ != nullptr) {
    UnmapViewOfFile(memory_);
  }
  if (controlMemory_ != nullptr) {
    UnmapViewOfFile(controlMemory_);
  }
  if (mappingHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(mappingHandle_));
  }
  if (eventHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(eventHandle_));
  }
  if (controlHandle_ != nullptr) {
    CloseHandle(static_cast<HANDLE>(controlHandle_));
  }
#endif
  mappingHandle_ = nullptr;
  eventHandle_ = nullptr;
  controlHandle_ = nullptr;
  memory_ = nullptr;
  controlMemory_ = nullptr;
  ringBytes_ = 0u;
  nextSequence_ = 1u;
  lastFrameTimestampQpc_ = 0u;
  token_.clear();
  mappingName_.clear();
  eventName_.clear();
  controlName_.clear();
}

bool VcamShmRingWin::active() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return memory_ != nullptr;
}

bool VcamShmRingWin::publishBgra(uint32_t width,
                                 uint32_t height,
                                 const uint8_t *bgra,
                                 size_t bgraSize,
                                 uint64_t captureQpc) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (memory_ == nullptr || width == 0u || height == 0u ||
      bgraSize != static_cast<size_t>(width) * height * 4u) {
    return false;
  }
  const uint64_t heartbeatQpc = nowQpc();
  uint64_t frameQpc = captureQpc;
  if (frameQpc == 0u || frameQpc <= lastFrameTimestampQpc_) {
    frameQpc = heartbeatQpc;
  }
  if (frameQpc <= lastFrameTimestampQpc_) {
    frameQpc = lastFrameTimestampQpc_ + 1u;
  }
  const bool ok = broadify::vcam_shm::publishFrame(
      memory_, ringBytes_, nextSequence_++, frameQpc, bgra, bgraSize,
      heartbeatQpc);
  if (ok) {
    lastFrameTimestampQpc_ = frameQpc;
  }
#if defined(_WIN32)
  if (ok && eventHandle_ != nullptr) {
    SetEvent(static_cast<HANDLE>(eventHandle_));
  }
#endif
  return ok;
}

bool VcamShmRingWin::heartbeat(uint64_t heartbeatQpc) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (memory_ == nullptr) {
    return false;
  }
  const uint64_t nextHeartbeat = heartbeatQpc == 0u ? nowQpc() : heartbeatQpc;
  if (controlMemory_ != nullptr) {
    auto *record =
        static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory_);
    broadify::vcam_shm::ControlRecord next;
    if (broadify::vcam_shm::readControlRecord(*record, next)) {
      next.heartbeat_qpc = nextHeartbeat;
      broadify::vcam_shm::writeControlRecord(*record, next);
    }
  }
  return broadify::vcam_shm::updateHeartbeat(
      memory_, ringBytes_, nextHeartbeat);
}

uint64_t VcamShmRingWin::readerCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (controlMemory_ == nullptr) {
    return 0u;
  }
  const auto *record =
      static_cast<const broadify::vcam_shm::ControlRecord *>(controlMemory_);
  broadify::vcam_shm::ControlRecord snapshot;
  if (!broadify::vcam_shm::readControlRecord(*record, snapshot)) {
    return 0u;
  }
#if defined(_WIN32)
  const uint64_t staleTicks = qpcStaleTicks(3000u);
  const uint64_t count = broadify::vcam_shm::countLiveReaders(
      snapshot, nowQpc(), staleTicks, isProcessAlive);
  *reinterpret_cast<volatile uint64_t *>(
      &static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory_)
           ->reader_count) = count;
  std::atomic_thread_fence(std::memory_order_release);
  return count;
#else
  return 0u;
#endif
}

bool VcamShmRingWin::readerHeartbeatAbsent(uint64_t staleMs) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (controlMemory_ == nullptr) {
    return true;
  }
#if defined(_WIN32)
  const auto *record =
      static_cast<const broadify::vcam_shm::ControlRecord *>(controlMemory_);
  broadify::vcam_shm::ControlRecord snapshot;
  if (!broadify::vcam_shm::readControlRecord(*record, snapshot)) {
    return true;
  }
  const uint64_t staleTicks = qpcStaleTicks(staleMs);
  return broadify::vcam_shm::countLiveReaders(
             snapshot, nowQpc(), staleTicks, isProcessAlive) == 0u;
#else
  (void)staleMs;
  return true;
#endif
}

bool VcamShmRingWin::openServiceRingLocked(uint32_t width,
                                           uint32_t height,
                                           uint32_t fps,
                                           uint64_t writerGeneration,
                                           bool globalNamespace,
                                           std::string &reason) {
#if defined(_WIN32)
  OpenedRingResources resources;
  resources.controlName = broadify::vcam_shm::controlMappingName(globalNamespace);
  resources.mappingName =
      broadify::vcam_shm::serviceStreamMappingName(globalNamespace);
  resources.eventName =
      broadify::vcam_shm::serviceStreamEventName(globalNamespace);
  resources.ringBytes = broadify::vcam_shm::maxServiceRingBytes();
  if (resources.ringBytes == 0u) {
    reason = "invalid geometry";
    return false;
  }

  resources.controlHandle = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE,
                                             FALSE,
                                             resources.controlName.c_str());
  if (resources.controlHandle == nullptr) {
    reason = "service_ring_absent";
    return false;
  }
  resources.mappingHandle = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE,
                                             FALSE,
                                             resources.mappingName.c_str());
  if (resources.mappingHandle == nullptr) {
    closeResources(resources);
    reason = "service_ring_absent";
    return false;
  }
  resources.eventHandle =
      OpenEventW(EVENT_MODIFY_STATE, FALSE, resources.eventName.c_str());
  if (resources.eventHandle == nullptr) {
    closeResources(resources);
    reason = "service_ring_absent";
    return false;
  }
  resources.controlMemory = MapViewOfFile(
      resources.controlHandle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
      sizeof(broadify::vcam_shm::ControlRecord));
  resources.memory = MapViewOfFile(resources.mappingHandle,
                                   FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
                                   resources.ringBytes);
  if (resources.controlMemory == nullptr || resources.memory == nullptr) {
    reason = lastErrorText("MapViewOfFile(service)");
    closeResources(resources);
    return false;
  }
  auto *record =
      static_cast<broadify::vcam_shm::ControlRecord *>(resources.controlMemory);
  broadify::vcam_shm::ControlRecord snapshot;
  if (!broadify::vcam_shm::readControlRecord(*record, snapshot) ||
      !broadify::vcam_shm::validateServiceControl(snapshot) ||
      !broadify::vcam_shm::validateServiceRing(resources.memory,
                                               resources.ringBytes)) {
    reason = "invalid_service_ring";
    closeResources(resources);
    return false;
  }

  const uint64_t heartbeatQpc = nowQpc();
  if (!broadify::vcam_shm::initializeRing(
          resources.memory, resources.ringBytes, width, height, fps, 1u,
          broadify::vcam_shm::PixelFormat::Bgra8, GetCurrentProcessId(),
          writerGeneration, heartbeatQpc)) {
    reason = "failed to initialize shared memory layout";
    closeResources(resources);
    return false;
  }
  auto *header =
      static_cast<broadify::vcam_shm::RingHeader *>(resources.memory);
  header->owner = static_cast<uint32_t>(broadify::vcam_shm::LayoutOwner::Service);
  header->capacity_bytes = resources.ringBytes;
  if (!publishControlRecord(resources.controlMemory, resources.mappingName,
                            resources.eventName, resources.ringBytes, width,
                            height, fps, writerGeneration, heartbeatQpc)) {
    reason = "failed to initialize shared memory control";
    closeResources(resources);
    return false;
  }
  mappingHandle_ = resources.mappingHandle;
  eventHandle_ = resources.eventHandle;
  controlHandle_ = resources.controlHandle;
  memory_ = resources.memory;
  controlMemory_ = resources.controlMemory;
  ringBytes_ = resources.ringBytes;
  token_ = resources.token;
  mappingName_ = resources.mappingName;
  eventName_ = resources.eventName;
  controlName_ = resources.controlName;
  nextSequence_ = 1u;
  lastFrameTimestampQpc_ = 0u;
  resources = OpenedRingResources{};
  reason = "opened_service_ring";
  return true;
#else
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  (void)globalNamespace;
  reason = "shared memory transport is Windows-only";
  return false;
#endif
}

bool VcamShmRingWin::createWithNamespace(bool globalNamespace,
                                         uint32_t width,
                                         uint32_t height,
                                         uint32_t fps,
                                         uint64_t writerGeneration,
                                         std::string &reason) {
#if defined(_WIN32)
  OpenedRingResources resources;
  const uint64_t startTick = GetTickCount64();
  resources.token =
      broadify::vcam_shm::makeStreamToken(GetCurrentProcessId(), startTick);
  resources.mappingName =
      broadify::vcam_shm::serviceStreamMappingName(globalNamespace);
  resources.eventName =
      broadify::vcam_shm::serviceStreamEventName(globalNamespace);
  resources.controlName = controlName_.empty()
                              ? broadify::vcam_shm::controlMappingName(globalNamespace)
                              : controlName_;
  resources.ringBytes = broadify::vcam_shm::maxServiceRingBytes();
  if (resources.ringBytes == 0u) {
    reason = "invalid geometry";
    return false;
  }

  SecurityAttributes streamSecurity(
      broadify::vcam_shm::streamSecurityDescriptorSddl());
  SecurityAttributes controlSecurity(
      broadify::vcam_shm::controlSecurityDescriptorSddl());
  LARGE_INTEGER size{};
  size.QuadPart = static_cast<LONGLONG>(resources.ringBytes);
  resources.mappingHandle = CreateFileMappingW(
      INVALID_HANDLE_VALUE, streamSecurity.get(), PAGE_READWRITE, size.HighPart,
      size.LowPart, resources.mappingName.c_str());
  if (resources.mappingHandle == nullptr) {
    reason = createMappingFailureReason("CreateFileMappingW(stream)",
                                        globalNamespace);
    return false;
  }

  resources.eventHandle =
      CreateEventW(streamSecurity.get(), FALSE, FALSE, resources.eventName.c_str());
  if (resources.eventHandle == nullptr) {
    reason = lastErrorText("CreateEventW(frame)");
    closeResources(resources);
    return false;
  }

  resources.controlHandle = CreateFileMappingW(
      INVALID_HANDLE_VALUE, controlSecurity.get(), PAGE_READWRITE, 0,
      static_cast<DWORD>(sizeof(broadify::vcam_shm::ControlRecord)),
      resources.controlName.c_str());
  if (resources.controlHandle == nullptr) {
    reason = createMappingFailureReason("CreateFileMappingW(control)",
                                        globalNamespace);
    closeResources(resources);
    return false;
  }
  const bool controlAlreadyExisted = GetLastError() == ERROR_ALREADY_EXISTS;

  resources.memory = MapViewOfFile(resources.mappingHandle, FILE_MAP_ALL_ACCESS,
                                   0, 0, resources.ringBytes);
  resources.controlMemory =
      MapViewOfFile(resources.controlHandle, FILE_MAP_ALL_ACCESS, 0, 0,
                    sizeof(broadify::vcam_shm::ControlRecord));
  if (resources.memory == nullptr || resources.controlMemory == nullptr) {
    reason = lastErrorText("MapViewOfFile");
    closeResources(resources);
    return false;
  }
  const uint64_t heartbeatQpc = nowQpc();
  if (controlAlreadyExisted) {
    const auto *record =
        static_cast<const broadify::vcam_shm::ControlRecord *>(
            resources.controlMemory);
    broadify::vcam_shm::ControlRecord existing;
    if (broadify::vcam_shm::readControlRecord(*record, existing)) {
      const uint64_t staleTicks = qpcStaleTicks(3000u);
      const bool heartbeatFresh =
          staleTicks > 0u && existing.heartbeat_qpc != 0u &&
          heartbeatQpc <= existing.heartbeat_qpc + staleTicks;
      if (heartbeatFresh && isProcessAlive(existing.writer_pid)) {
        emitHelperEvent("{\"type\":\"meeting_vcam_raw\",\"event\":\"vcam_shm_control_busy\"}");
        reason = "vcam_shm_control_busy";
        closeResources(resources);
        return false;
      }
    }
  }
  if (!broadify::vcam_shm::initializeRing(
          resources.memory, resources.ringBytes, width, height, fps, 1u,
          broadify::vcam_shm::PixelFormat::Bgra8, GetCurrentProcessId(),
          writerGeneration, heartbeatQpc)) {
    reason = "failed to initialize shared memory layout";
    closeResources(resources);
    return false;
  }
  auto *header =
      static_cast<broadify::vcam_shm::RingHeader *>(resources.memory);
  header->owner = static_cast<uint32_t>(broadify::vcam_shm::LayoutOwner::Service);
  header->capacity_bytes = resources.ringBytes;
  if (!publishControlRecord(resources.controlMemory, resources.mappingName,
                            resources.eventName, resources.ringBytes, width,
                            height, fps, writerGeneration, heartbeatQpc)) {
    reason = "failed to initialize shared memory layout";
    closeResources(resources);
    return false;
  }
  mappingHandle_ = resources.mappingHandle;
  eventHandle_ = resources.eventHandle;
  controlHandle_ = resources.controlHandle;
  memory_ = resources.memory;
  controlMemory_ = resources.controlMemory;
  ringBytes_ = resources.ringBytes;
  token_ = resources.token;
  mappingName_ = resources.mappingName;
  eventName_ = resources.eventName;
  controlName_ = resources.controlName;
  nextSequence_ = 1u;
  lastFrameTimestampQpc_ = 0u;
  resources = OpenedRingResources{};
  return true;
#else
  (void)globalNamespace;
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  reason = "shared memory transport is Windows-only";
  return false;
#endif
}

}  // namespace broadify::meeting
