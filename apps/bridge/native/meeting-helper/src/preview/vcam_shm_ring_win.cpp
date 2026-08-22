#include "preview/vcam_shm_ring_win.h"

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

#endif

}  // namespace

VcamShmRingWin::VcamShmRingWin() = default;

VcamShmRingWin::~VcamShmRingWin() { close(); }

VcamShmCreateResult VcamShmRingWin::create(uint32_t width,
                                           uint32_t height,
                                           uint32_t fps,
                                           uint64_t writerGeneration) {
  close();
#if defined(_WIN32)
  std::string reason;
  if (createWithNamespace(true, width, height, fps, writerGeneration, reason)) {
    return VcamShmCreateResult{true, true, ""};
  }
  const std::string globalReason = reason;
  if (createWithNamespace(false, width, height, fps, writerGeneration, reason)) {
    return VcamShmCreateResult{
        true, false, "global namespace unavailable: " + globalReason};
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
    const std::wstring &controlName) {
  close();
#if defined(_WIN32)
  std::string reason;
  controlName_ = controlName;
  if (createWithNamespace(true, width, height, fps, writerGeneration, reason)) {
    return VcamShmCreateResult{true, true, ""};
  }
  return VcamShmCreateResult{false, false, reason};
#else
  (void)width;
  (void)height;
  (void)fps;
  (void)writerGeneration;
  (void)controlName;
  return VcamShmCreateResult{false, false, "shared memory transport is Windows-only"};
#endif
}

void VcamShmRingWin::close() {
  std::lock_guard<std::mutex> lock(mutex_);
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

bool VcamShmRingWin::publishControl(uint32_t width,
                                    uint32_t height,
                                    uint32_t fps,
                                    uint64_t writerGeneration,
                                    uint64_t heartbeatQpc) {
  if (controlMemory_ == nullptr) {
    return false;
  }
  broadify::vcam_shm::ControlRecord next;
  if (!broadify::vcam_shm::initializeControlRecord(
          next, mappingName_, eventName_, width, height, fps, 1u,
          broadify::vcam_shm::PixelFormat::Bgra8,
#if defined(_WIN32)
          static_cast<uint32_t>(GetCurrentProcessId()),
#else
          0u,
#endif
          writerGeneration, heartbeatQpc)) {
    return false;
  }
  auto *record = static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory_);
  return broadify::vcam_shm::writeControlRecord(*record, next);
}

bool VcamShmRingWin::createWithNamespace(bool globalNamespace,
                                         uint32_t width,
                                         uint32_t height,
                                         uint32_t fps,
                                         uint64_t writerGeneration,
                                         std::string &reason) {
#if defined(_WIN32)
  const uint64_t startTick = GetTickCount64();
  token_ = broadify::vcam_shm::makeStreamToken(GetCurrentProcessId(), startTick);
  mappingName_ = broadify::vcam_shm::streamMappingName(token_, globalNamespace);
  eventName_ = broadify::vcam_shm::streamEventName(token_, globalNamespace);
  if (controlName_.empty()) {
    controlName_ = broadify::vcam_shm::controlMappingName(globalNamespace);
  }
  ringBytes_ =
      broadify::vcam_shm::ringBytesFor(width, height, broadify::vcam_shm::PixelFormat::Bgra8);
  if (ringBytes_ == 0u) {
    reason = "invalid geometry";
    return false;
  }

  SecurityAttributes streamSecurity(
      broadify::vcam_shm::streamSecurityDescriptorSddl());
  SecurityAttributes controlSecurity(
      broadify::vcam_shm::controlSecurityDescriptorSddl());
  LARGE_INTEGER size{};
  size.QuadPart = static_cast<LONGLONG>(ringBytes_);
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE, streamSecurity.get(), PAGE_READWRITE, size.HighPart,
      size.LowPart, mappingName_.c_str());
  if (mapping == nullptr) {
    reason = lastErrorText("CreateFileMappingW(stream)");
    close();
    return false;
  }
  mappingHandle_ = mapping;

  HANDLE event =
      CreateEventW(streamSecurity.get(), FALSE, FALSE, eventName_.c_str());
  if (event == nullptr) {
    reason = lastErrorText("CreateEventW(frame)");
    close();
    return false;
  }
  eventHandle_ = event;

  HANDLE control = CreateFileMappingW(
      INVALID_HANDLE_VALUE, controlSecurity.get(), PAGE_READWRITE, 0,
      static_cast<DWORD>(sizeof(broadify::vcam_shm::ControlRecord)),
      controlName_.c_str());
  if (control == nullptr) {
    reason = lastErrorText("CreateFileMappingW(control)");
    close();
    return false;
  }
  controlHandle_ = control;
  const bool controlAlreadyExisted = GetLastError() == ERROR_ALREADY_EXISTS;

  memory_ = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, ringBytes_);
  controlMemory_ =
      MapViewOfFile(control, FILE_MAP_ALL_ACCESS, 0, 0,
                    sizeof(broadify::vcam_shm::ControlRecord));
  if (memory_ == nullptr || controlMemory_ == nullptr) {
    reason = lastErrorText("MapViewOfFile");
    close();
    return false;
  }
  const uint64_t heartbeatQpc = nowQpc();
  if (controlAlreadyExisted) {
    const auto *record =
        static_cast<const broadify::vcam_shm::ControlRecord *>(controlMemory_);
    broadify::vcam_shm::ControlRecord existing;
    if (broadify::vcam_shm::readControlRecord(*record, existing)) {
      const uint64_t staleTicks = qpcStaleTicks(3000u);
      const bool heartbeatFresh =
          staleTicks > 0u && existing.heartbeat_qpc != 0u &&
          heartbeatQpc <= existing.heartbeat_qpc + staleTicks;
      if (heartbeatFresh && isProcessAlive(existing.writer_pid)) {
        std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"vcam_shm_control_busy\"}"
                  << std::endl;
        reason = "vcam_shm_control_busy";
        close();
        return false;
      }
    }
  }
  if (!broadify::vcam_shm::initializeRing(
          memory_, ringBytes_, width, height, fps, 1u,
          broadify::vcam_shm::PixelFormat::Bgra8, GetCurrentProcessId(),
          writerGeneration, heartbeatQpc) ||
      !publishControl(width, height, fps, writerGeneration, heartbeatQpc)) {
    reason = "failed to initialize shared memory layout";
    close();
    return false;
  }
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
