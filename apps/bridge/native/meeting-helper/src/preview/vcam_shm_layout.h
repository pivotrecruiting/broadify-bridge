#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace broadify::vcam_shm {

constexpr uint32_t kRingMagic = 0x4d534642u;  // "BFSM" little endian.
constexpr uint32_t kControlMagic = 0x43534642u;  // "BFSC" little endian.
constexpr uint32_t kLayoutVersion = 2u;
constexpr uint32_t kSlotCount = 3u;
constexpr uint32_t kMaxNameChars = 128u;
constexpr uint32_t kReaderSlotCount = 4u;
constexpr uint32_t kDefaultFpsNum = 30u;
constexpr uint32_t kDefaultFpsDen = 1u;
constexpr uint32_t kMaxServiceWidth = 1920u;
constexpr uint32_t kMaxServiceHeight = 1080u;

enum class PixelFormat : uint32_t {
  Unknown = 0,
  Bgra8 = 2,
  Nv12 = 3,
};

enum class LayoutOwner : uint32_t {
  Unknown = 0,
  Helper = 1,
  Service = 2,
};

struct RingHeader {
  uint32_t magic = kRingMagic;
  uint32_t version = kLayoutVersion;
  uint32_t owner = static_cast<uint32_t>(LayoutOwner::Unknown);
  uint32_t reserved0 = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps_num = kDefaultFpsNum;
  uint32_t fps_den = kDefaultFpsDen;
  uint32_t format = static_cast<uint32_t>(PixelFormat::Bgra8);
  uint32_t slot_count = kSlotCount;
  uint32_t slot_stride = 0;
  uint64_t capacity_bytes = 0;
  uint64_t writer_pid = 0;
  uint64_t writer_generation = 0;
  uint64_t heartbeat_qpc = 0;
  uint64_t reader_count = 0;
};

struct SlotHeader {
  uint64_t sequence = 0;
  uint64_t capture_qpc = 0;
  uint32_t size = 0;
  uint32_t reserved0 = 0;
};

struct ReaderSlot {
  uint32_t pid = 0;
  uint32_t reserved0 = 0;
  uint64_t last_seen_qpc = 0;
};

struct ControlRecord {
  uint32_t magic = kControlMagic;
  uint32_t version = kLayoutVersion;
  uint32_t owner = static_cast<uint32_t>(LayoutOwner::Unknown);
  uint32_t reserved0 = 0;
  uint64_t sequence = 0;
  uint64_t writer_generation = 0;
  uint64_t heartbeat_qpc = 0;
  uint64_t reader_count = 0;
  uint64_t capacity_bytes = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps_num = kDefaultFpsNum;
  uint32_t fps_den = kDefaultFpsDen;
  uint32_t format = static_cast<uint32_t>(PixelFormat::Bgra8);
  uint32_t writer_pid = 0;
  ReaderSlot readers[kReaderSlotCount] = {};
  wchar_t mapping_name[kMaxNameChars] = {};
  wchar_t event_name[kMaxNameChars] = {};
};

struct FrameView {
  uint32_t width = 0;
  uint32_t height = 0;
  PixelFormat format = PixelFormat::Unknown;
  uint64_t sequence = 0;
  uint64_t capture_qpc = 0;
  const uint8_t *data = nullptr;
  size_t size = 0;
};

struct CopiedFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  PixelFormat format = PixelFormat::Unknown;
  uint64_t sequence = 0;
  uint64_t capture_qpc = 0;
  std::vector<uint8_t> data;
};

size_t alignUp(size_t value, size_t alignment);
size_t bytesPerFrame(uint32_t width, uint32_t height, PixelFormat format);
size_t slotStrideFor(uint32_t width, uint32_t height, PixelFormat format);
size_t ringBytesFor(uint32_t width, uint32_t height, PixelFormat format);
size_t maxServiceRingBytes();

bool initializeRing(void *memory,
                    size_t bytes,
                    uint32_t width,
                    uint32_t height,
                    uint32_t fpsNum,
                    uint32_t fpsDen,
                    PixelFormat format,
                    uint64_t writerPid,
                    uint64_t writerGeneration,
                    uint64_t heartbeatQpc);
bool initializeServiceRing(void *memory,
                           size_t bytes,
                           uint64_t heartbeatQpc);
bool validateServiceRing(const void *memory, size_t bytes);
bool validateServiceControl(const ControlRecord &record);

RingHeader *ringHeader(void *memory, size_t bytes);
const RingHeader *ringHeader(const void *memory, size_t bytes);
SlotHeader *slotHeader(void *memory, size_t bytes, uint32_t slotIndex);
const SlotHeader *slotHeader(const void *memory, size_t bytes, uint32_t slotIndex);
uint8_t *slotData(void *memory, size_t bytes, uint32_t slotIndex);
const uint8_t *slotData(const void *memory, size_t bytes, uint32_t slotIndex);

bool publishFrame(void *memory,
                  size_t bytes,
                  uint64_t sequence,
                  uint64_t captureQpc,
                  const uint8_t *data,
                  size_t dataSize,
                  uint64_t heartbeatQpc);

bool copyNewestFrame(const void *memory, size_t bytes, CopiedFrame &frame);
#if defined(_WIN32)
bool copyNewestFrameInto(const void *memory,
                         size_t bytes,
                         FrameView &frame,
                         std::vector<uint8_t> &data);
#endif
bool peekNewestFrame(const void *memory, size_t bytes, FrameView &frame);
bool updateHeartbeat(void *memory, size_t bytes, uint64_t heartbeatQpc);

std::wstring makeStreamToken(uint64_t pid, uint64_t startTick);
std::wstring streamMappingName(const std::wstring &token, bool globalNamespace);
std::wstring streamEventName(const std::wstring &token, bool globalNamespace);
std::wstring controlMappingName(bool globalNamespace);
std::wstring serviceStreamMappingName(bool globalNamespace);
std::wstring serviceStreamEventName(bool globalNamespace);
std::wstring streamSecurityDescriptorSddl();
std::wstring controlSecurityDescriptorSddl();
std::wstring frameEventSecurityDescriptorSddl();
std::wstring securityDescriptorSddl();

bool initializeControlRecord(ControlRecord &record,
                             const std::wstring &mappingName,
                             const std::wstring &eventName,
                             uint32_t width,
                             uint32_t height,
                             uint32_t fpsNum,
                             uint32_t fpsDen,
                             PixelFormat format,
                             uint32_t writerPid,
                             uint64_t writerGeneration,
                             uint64_t heartbeatQpc);
bool writeControlRecord(ControlRecord &record, const ControlRecord &next);
bool readControlRecord(const ControlRecord &record, ControlRecord &out);
bool updateReaderSlot(ControlRecord &record, uint32_t pid, uint64_t nowQpc);
void clearReaderSlot(ControlRecord &record, uint32_t pid);
uint64_t countLiveReaders(const ControlRecord &record,
                          uint64_t nowQpc,
                          uint64_t staleTicks,
                          bool (*pidAlive)(uint32_t pid));

void bgraToNv12(const uint8_t *bgra,
                uint32_t width,
                uint32_t height,
                uint8_t *nv12,
                size_t nv12Size);

}  // namespace broadify::vcam_shm
