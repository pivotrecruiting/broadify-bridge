#include "preview/vcam_shm_ring_win.h"

#include <cstring>

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

class SecurityAttributes {
 public:
  SecurityAttributes() {
    const std::wstring sddl = broadify::vcam_shm::securityDescriptorSddl();
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

void VcamShmRingWin::close() {
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
  if (memory_ == nullptr || width == 0u || height == 0u ||
      bgraSize != static_cast<size_t>(width) * height * 4u) {
    return false;
  }
  const uint64_t heartbeatQpc = captureQpc == 0u ? nowQpc() : captureQpc;
  const bool ok = broadify::vcam_shm::publishFrame(
      memory_, ringBytes_, nextSequence_++, captureQpc, bgra, bgraSize,
      heartbeatQpc);
#if defined(_WIN32)
  if (ok && eventHandle_ != nullptr) {
    SetEvent(static_cast<HANDLE>(eventHandle_));
  }
#endif
  return ok;
}

bool VcamShmRingWin::heartbeat(uint64_t heartbeatQpc) {
  if (memory_ == nullptr) {
    return false;
  }
  return broadify::vcam_shm::updateHeartbeat(
      memory_, ringBytes_, heartbeatQpc == 0u ? nowQpc() : heartbeatQpc);
}

uint64_t VcamShmRingWin::readerCount() const {
  if (controlMemory_ == nullptr) {
    return 0u;
  }
  const auto *record =
      static_cast<const broadify::vcam_shm::ControlRecord *>(controlMemory_);
  return record->reader_count;
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
  controlName_ = broadify::vcam_shm::controlMappingName(globalNamespace);
  ringBytes_ =
      broadify::vcam_shm::ringBytesFor(width, height, broadify::vcam_shm::PixelFormat::Bgra8);
  if (ringBytes_ == 0u) {
    reason = "invalid geometry";
    return false;
  }

  SecurityAttributes security;
  LARGE_INTEGER size{};
  size.QuadPart = static_cast<LONGLONG>(ringBytes_);
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, size.HighPart,
      size.LowPart, mappingName_.c_str());
  if (mapping == nullptr) {
    reason = lastErrorText("CreateFileMappingW(stream)");
    close();
    return false;
  }
  mappingHandle_ = mapping;

  HANDLE event = CreateEventW(security.get(), FALSE, FALSE, eventName_.c_str());
  if (event == nullptr) {
    reason = lastErrorText("CreateEventW(frame)");
    close();
    return false;
  }
  eventHandle_ = event;

  HANDLE control = CreateFileMappingW(
      INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, 0,
      static_cast<DWORD>(sizeof(broadify::vcam_shm::ControlRecord)),
      controlName_.c_str());
  if (control == nullptr) {
    reason = lastErrorText("CreateFileMappingW(control)");
    close();
    return false;
  }
  controlHandle_ = control;

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
