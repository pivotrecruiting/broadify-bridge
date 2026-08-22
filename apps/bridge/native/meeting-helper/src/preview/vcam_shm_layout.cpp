#include "preview/vcam_shm_layout.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cwchar>
#include <limits>

namespace broadify::vcam_shm {
namespace {

constexpr size_t kAlignment = 64u;

bool checkedMul(size_t a, size_t b, size_t &out) {
  if (a != 0u && b > std::numeric_limits<size_t>::max() / a) {
    return false;
  }
  out = a * b;
  return true;
}

bool checkedAdd(size_t a, size_t b, size_t &out) {
  if (b > std::numeric_limits<size_t>::max() - a) {
    return false;
  }
  out = a + b;
  return true;
}

uint8_t clampByte(int value) {
  return static_cast<uint8_t>(std::clamp(value, 0, 255));
}

uint8_t lumaFromBgra(const uint8_t *pixel) {
  const int b = pixel[0];
  const int g = pixel[1];
  const int r = pixel[2];
  return clampByte(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
}

void chromaFromBgra2x2(const uint8_t *bgra,
                       uint32_t width,
                       uint32_t height,
                       uint32_t x,
                       uint32_t y,
                       uint8_t &u,
                       uint8_t &v) {
  int sumR = 0;
  int sumG = 0;
  int sumB = 0;
  int count = 0;
  for (uint32_t dy = 0; dy < 2u && y + dy < height; ++dy) {
    for (uint32_t dx = 0; dx < 2u && x + dx < width; ++dx) {
      const uint8_t *pixel =
          bgra + (static_cast<size_t>(y + dy) * width + (x + dx)) * 4u;
      sumB += pixel[0];
      sumG += pixel[1];
      sumR += pixel[2];
      ++count;
    }
  }
  const int r = count > 0 ? sumR / count : 0;
  const int g = count > 0 ? sumG / count : 0;
  const int b = count > 0 ? sumB / count : 0;
  u = clampByte(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
  v = clampByte(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
}

bool validHeader(const RingHeader *header, size_t bytes) {
  if (header == nullptr || bytes < sizeof(RingHeader)) {
    return false;
  }
  if (header->magic != kRingMagic || header->version != kLayoutVersion ||
      header->slot_count != kSlotCount ||
      header->owner == static_cast<uint32_t>(LayoutOwner::Unknown) ||
      header->capacity_bytes < bytes || header->width == 0u ||
      header->height == 0u || header->slot_stride < sizeof(SlotHeader)) {
    return false;
  }
  const PixelFormat format = static_cast<PixelFormat>(header->format);
  const size_t required = ringBytesFor(header->width, header->height, format);
  return required != 0u && required <= bytes && required <= header->capacity_bytes;
}

void copyWideName(wchar_t *dst, const std::wstring &src) {
  std::wmemset(dst, 0, kMaxNameChars);
  const size_t count = std::min<size_t>(src.size(), kMaxNameChars - 1u);
  if (count > 0u) {
    std::wmemcpy(dst, src.c_str(), count);
  }
}

uint64_t volatileLoad64(const uint64_t &value) {
  return *reinterpret_cast<const volatile uint64_t *>(&value);
}

void volatileStore64(uint64_t &value, uint64_t next) {
  *reinterpret_cast<volatile uint64_t *>(&value) = next;
}

}  // namespace

size_t alignUp(size_t value, size_t alignment) {
  if (alignment == 0u) {
    return value;
  }
  const size_t remainder = value % alignment;
  return remainder == 0u ? value : value + (alignment - remainder);
}

size_t bytesPerFrame(uint32_t width, uint32_t height, PixelFormat format) {
  size_t pixels = 0;
  if (!checkedMul(static_cast<size_t>(width), static_cast<size_t>(height),
                  pixels)) {
    return 0u;
  }
  switch (format) {
    case PixelFormat::Bgra8:
      return pixels > std::numeric_limits<size_t>::max() / 4u ? 0u
                                                              : pixels * 4u;
    case PixelFormat::Nv12:
      return pixels > (std::numeric_limits<size_t>::max() / 3u) * 2u
                 ? 0u
                 : (pixels * 3u) / 2u;
    default:
      return 0u;
  }
}

size_t slotStrideFor(uint32_t width, uint32_t height, PixelFormat format) {
  size_t payload = bytesPerFrame(width, height, format);
  size_t total = 0;
  if (payload == 0u || !checkedAdd(sizeof(SlotHeader), payload, total)) {
    return 0u;
  }
  return alignUp(total, kAlignment);
}

size_t ringBytesFor(uint32_t width, uint32_t height, PixelFormat format) {
  const size_t stride = slotStrideFor(width, height, format);
  if (stride == 0u) {
    return 0u;
  }
  size_t slots = 0;
  size_t total = 0;
  if (!checkedMul(stride, static_cast<size_t>(kSlotCount), slots) ||
      !checkedAdd(alignUp(sizeof(RingHeader), kAlignment), slots, total)) {
    return 0u;
  }
  return total;
}

size_t maxServiceRingBytes() {
  return ringBytesFor(kMaxServiceWidth, kMaxServiceHeight, PixelFormat::Bgra8);
}

bool initializeRing(void *memory,
                    size_t bytes,
                    uint32_t width,
                    uint32_t height,
                    uint32_t fpsNum,
                    uint32_t fpsDen,
                    PixelFormat format,
                    uint64_t writerPid,
                    uint64_t writerGeneration,
                    uint64_t heartbeatQpc) {
  const size_t required = ringBytesFor(width, height, format);
  if (memory == nullptr || required == 0u || bytes < required) {
    return false;
  }
  std::memset(memory, 0, bytes);
  RingHeader *header = reinterpret_cast<RingHeader *>(memory);
  header->magic = kRingMagic;
  header->version = kLayoutVersion;
  header->owner = static_cast<uint32_t>(LayoutOwner::Helper);
  header->width = width;
  header->height = height;
  header->fps_num = fpsNum == 0u ? kDefaultFpsNum : fpsNum;
  header->fps_den = fpsDen == 0u ? kDefaultFpsDen : fpsDen;
  header->format = static_cast<uint32_t>(format);
  header->slot_count = kSlotCount;
  header->slot_stride = static_cast<uint32_t>(slotStrideFor(width, height, format));
  header->capacity_bytes = bytes;
  header->writer_pid = writerPid;
  header->writer_generation = writerGeneration;
  header->heartbeat_qpc = heartbeatQpc;
  header->reader_count = 0;
  return true;
}

bool initializeServiceRing(void *memory, size_t bytes, uint64_t heartbeatQpc) {
  const size_t capacity = maxServiceRingBytes();
  if (memory == nullptr || capacity == 0u || bytes < capacity) {
    return false;
  }
  std::memset(memory, 0, bytes);
  RingHeader *header = reinterpret_cast<RingHeader *>(memory);
  header->magic = kRingMagic;
  header->version = kLayoutVersion;
  header->owner = static_cast<uint32_t>(LayoutOwner::Service);
  header->fps_num = kDefaultFpsNum;
  header->fps_den = kDefaultFpsDen;
  header->format = static_cast<uint32_t>(PixelFormat::Bgra8);
  header->slot_count = kSlotCount;
  header->capacity_bytes = bytes;
  header->writer_generation = 0u;
  header->heartbeat_qpc = heartbeatQpc;
  return true;
}

bool validateServiceRing(const void *memory, size_t bytes) {
  if (memory == nullptr || bytes < sizeof(RingHeader)) {
    return false;
  }
  const auto *header = reinterpret_cast<const RingHeader *>(memory);
  if (header->magic != kRingMagic || header->version != kLayoutVersion ||
      header->owner != static_cast<uint32_t>(LayoutOwner::Service) ||
      header->slot_count != kSlotCount ||
      header->capacity_bytes < maxServiceRingBytes() ||
      header->capacity_bytes > bytes ||
      header->format != static_cast<uint32_t>(PixelFormat::Bgra8)) {
    return false;
  }
  if (header->width == 0u && header->height == 0u &&
      header->slot_stride == 0u && header->writer_generation == 0u) {
    return true;
  }
  return validHeader(header, bytes);
}

bool validateServiceControl(const ControlRecord &record) {
  if (record.magic != kControlMagic || record.version != kLayoutVersion ||
      record.owner != static_cast<uint32_t>(LayoutOwner::Service) ||
      record.capacity_bytes < maxServiceRingBytes() ||
      record.mapping_name[0] == L'\0' || record.event_name[0] == L'\0') {
    return false;
  }
  if (record.width == 0u && record.height == 0u &&
      record.writer_generation == 0u) {
    return true;
  }
  const PixelFormat format = static_cast<PixelFormat>(record.format);
  const size_t required = ringBytesFor(record.width, record.height, format);
  return required != 0u && required <= record.capacity_bytes &&
         record.fps_num != 0u && record.fps_den != 0u;
}

RingHeader *ringHeader(void *memory, size_t bytes) {
  RingHeader *header = bytes >= sizeof(RingHeader)
                           ? reinterpret_cast<RingHeader *>(memory)
                           : nullptr;
  return validHeader(header, bytes) ? header : nullptr;
}

const RingHeader *ringHeader(const void *memory, size_t bytes) {
  const RingHeader *header = bytes >= sizeof(RingHeader)
                                 ? reinterpret_cast<const RingHeader *>(memory)
                                 : nullptr;
  return validHeader(header, bytes) ? header : nullptr;
}

SlotHeader *slotHeader(void *memory, size_t bytes, uint32_t slotIndex) {
  RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr || slotIndex >= header->slot_count) {
    return nullptr;
  }
  const size_t offset =
      alignUp(sizeof(RingHeader), kAlignment) +
      static_cast<size_t>(slotIndex) * header->slot_stride;
  return offset + sizeof(SlotHeader) <= bytes
             ? reinterpret_cast<SlotHeader *>(static_cast<uint8_t *>(memory) + offset)
             : nullptr;
}

const SlotHeader *slotHeader(const void *memory, size_t bytes, uint32_t slotIndex) {
  const RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr || slotIndex >= header->slot_count) {
    return nullptr;
  }
  const size_t offset =
      alignUp(sizeof(RingHeader), kAlignment) +
      static_cast<size_t>(slotIndex) * header->slot_stride;
  return offset + sizeof(SlotHeader) <= bytes
             ? reinterpret_cast<const SlotHeader *>(static_cast<const uint8_t *>(memory) + offset)
             : nullptr;
}

uint8_t *slotData(void *memory, size_t bytes, uint32_t slotIndex) {
  SlotHeader *slot = slotHeader(memory, bytes, slotIndex);
  return slot == nullptr ? nullptr : reinterpret_cast<uint8_t *>(slot) + sizeof(SlotHeader);
}

const uint8_t *slotData(const void *memory, size_t bytes, uint32_t slotIndex) {
  const SlotHeader *slot = slotHeader(memory, bytes, slotIndex);
  return slot == nullptr ? nullptr : reinterpret_cast<const uint8_t *>(slot) + sizeof(SlotHeader);
}

bool publishFrame(void *memory,
                  size_t bytes,
                  uint64_t sequence,
                  uint64_t captureQpc,
                  const uint8_t *data,
                  size_t dataSize,
                  uint64_t heartbeatQpc) {
  RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr || data == nullptr || sequence == 0u) {
    return false;
  }
  const PixelFormat format = static_cast<PixelFormat>(header->format);
  const size_t expected = bytesPerFrame(header->width, header->height, format);
  if (expected == 0u || dataSize != expected) {
    return false;
  }
  const uint32_t slotIndex = static_cast<uint32_t>((sequence - 1u) % header->slot_count);
  SlotHeader *slot = slotHeader(memory, bytes, slotIndex);
  uint8_t *dst = slotData(memory, bytes, slotIndex);
  if (slot == nullptr || dst == nullptr) {
    return false;
  }
  const uint64_t evenSequence = sequence * 2u;
  // Boehm seqlock pattern: publish odd first, fence before payload writes,
  // then release-fence before publishing the even sequence.
  volatileStore64(slot->sequence, evenSequence | 1u);
  std::atomic_thread_fence(std::memory_order_seq_cst);
  std::memcpy(dst, data, dataSize);
  slot->capture_qpc = captureQpc;
  slot->size = static_cast<uint32_t>(dataSize);
  std::atomic_thread_fence(std::memory_order_release);
  volatileStore64(slot->sequence, evenSequence);
  std::atomic_thread_fence(std::memory_order_release);
  volatileStore64(header->heartbeat_qpc, heartbeatQpc);
  return true;
}

bool peekNewestFrame(const void *memory, size_t bytes, FrameView &frame) {
  const RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr) {
    return false;
  }
  const SlotHeader *best = nullptr;
  const uint8_t *bestData = nullptr;
  uint64_t bestSequence = 0u;
  for (uint32_t i = 0; i < header->slot_count; ++i) {
    const SlotHeader *slot = slotHeader(memory, bytes, i);
    const uint8_t *data = slotData(memory, bytes, i);
    if (slot == nullptr || data == nullptr) {
      return false;
    }
    const uint64_t sequence = volatileLoad64(slot->sequence);
    std::atomic_thread_fence(std::memory_order_acquire);
    if ((sequence & 1u) != 0u || sequence == 0u || sequence < bestSequence) {
      continue;
    }
    best = slot;
    bestData = data;
    bestSequence = sequence;
  }
  if (best == nullptr) {
    return false;
  }
  frame.width = header->width;
  frame.height = header->height;
  frame.format = static_cast<PixelFormat>(header->format);
  frame.sequence = bestSequence;
  frame.capture_qpc = best->capture_qpc;
  frame.data = bestData;
  frame.size = best->size;
  return true;
}

bool copyNewestFrame(const void *memory, size_t bytes, CopiedFrame &frame) {
  const RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr) {
    return false;
  }
  const size_t expected = bytesPerFrame(
      header->width, header->height, static_cast<PixelFormat>(header->format));
  if (expected == 0u) {
    return false;
  }
  const SlotHeader *best = nullptr;
  const uint8_t *bestData = nullptr;
  uint64_t bestSequence = 0u;
  for (uint32_t i = 0; i < header->slot_count; ++i) {
    const SlotHeader *slot = slotHeader(memory, bytes, i);
    const uint8_t *data = slotData(memory, bytes, i);
    if (slot == nullptr || data == nullptr) {
      return false;
    }
    const uint64_t sequence = volatileLoad64(slot->sequence);
    std::atomic_thread_fence(std::memory_order_acquire);
    if ((sequence & 1u) != 0u || sequence == 0u || sequence < bestSequence) {
      continue;
    }
    best = slot;
    bestData = data;
    bestSequence = sequence;
  }
  if (best == nullptr || best->size != expected) {
    return false;
  }
  frame.width = header->width;
  frame.height = header->height;
  frame.format = static_cast<PixelFormat>(header->format);
  frame.sequence = bestSequence;
  frame.capture_qpc = best->capture_qpc;
  frame.data.resize(expected);
  std::memcpy(frame.data.data(), bestData, expected);
  std::atomic_thread_fence(std::memory_order_acquire);
  const uint64_t after = volatileLoad64(best->sequence);
  return after == bestSequence && (after & 1u) == 0u;
}

bool updateHeartbeat(void *memory, size_t bytes, uint64_t heartbeatQpc) {
  RingHeader *header = ringHeader(memory, bytes);
  if (header == nullptr) {
    return false;
  }
  std::atomic_thread_fence(std::memory_order_release);
  volatileStore64(header->heartbeat_qpc, heartbeatQpc);
  return true;
}

std::wstring makeStreamToken(uint64_t pid, uint64_t startTick) {
  return std::to_wstring(pid) + L"-" + std::to_wstring(startTick);
}

std::wstring streamMappingName(const std::wstring &token, bool globalNamespace) {
  return std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
         L"BroadifyVcam-" + token;
}

std::wstring streamEventName(const std::wstring &token, bool globalNamespace) {
  return std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
         L"BroadifyVcamFrame-" + token;
}

std::wstring controlMappingName(bool globalNamespace) {
  return std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
         L"BroadifyVcam-control";
}

std::wstring serviceStreamMappingName(bool globalNamespace) {
  return std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
         L"BroadifyVcam-stream";
}

std::wstring serviceStreamEventName(bool globalNamespace) {
  return std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
         L"BroadifyVcam-frame";
}

std::wstring streamSecurityDescriptorSddl() {
  return L"D:P(A;;GA;;;LS)(A;;GRGW;;;IU)(A;;GRGW;;;AU)";
}

std::wstring controlSecurityDescriptorSddl() {
  return L"D:P(A;;GA;;;LS)(A;;GWGR;;;IU)(A;;GWGR;;;AU)";
}

std::wstring securityDescriptorSddl() {
  return streamSecurityDescriptorSddl();
}

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
                             uint64_t heartbeatQpc) {
  if (mappingName.empty() || eventName.empty() ||
      mappingName.size() >= kMaxNameChars || eventName.size() >= kMaxNameChars ||
      width == 0u || height == 0u) {
    return false;
  }
  record = ControlRecord{};
  record.magic = kControlMagic;
  record.version = kLayoutVersion;
  record.owner = static_cast<uint32_t>(LayoutOwner::Helper);
  record.width = width;
  record.height = height;
  record.fps_num = fpsNum == 0u ? kDefaultFpsNum : fpsNum;
  record.fps_den = fpsDen == 0u ? kDefaultFpsDen : fpsDen;
  record.format = static_cast<uint32_t>(format);
  record.capacity_bytes = ringBytesFor(width, height, format);
  record.writer_pid = writerPid;
  record.writer_generation = writerGeneration;
  record.heartbeat_qpc = heartbeatQpc;
  copyWideName(record.mapping_name, mappingName);
  copyWideName(record.event_name, eventName);
  return true;
}

bool writeControlRecord(ControlRecord &record, const ControlRecord &next) {
  if (next.magic != kControlMagic || next.version != kLayoutVersion ||
      next.owner == static_cast<uint32_t>(LayoutOwner::Unknown) ||
      next.capacity_bytes == 0u ||
      next.mapping_name[0] == L'\0' || next.event_name[0] == L'\0') {
    return false;
  }
  const uint64_t nextSequence = (record.sequence + 2u) & ~1ull;
  const uint64_t keepReaderCount = volatileLoad64(record.reader_count);
  ReaderSlot keepReaders[kReaderSlotCount] = {};
  std::memcpy(keepReaders, record.readers, sizeof(keepReaders));
  // Boehm seqlock pattern for the control record mirrors frame slots.
  volatileStore64(record.sequence, nextSequence | 1u);
  std::atomic_thread_fence(std::memory_order_seq_cst);
  record.magic = next.magic;
  record.version = next.version;
  record.owner = next.owner;
  record.reserved0 = next.reserved0;
  record.writer_generation = next.writer_generation;
  record.heartbeat_qpc = next.heartbeat_qpc;
  record.reader_count = keepReaderCount;
  record.capacity_bytes = next.capacity_bytes;
  record.width = next.width;
  record.height = next.height;
  record.fps_num = next.fps_num;
  record.fps_den = next.fps_den;
  record.format = next.format;
  record.writer_pid = next.writer_pid;
  std::memcpy(record.readers, keepReaders, sizeof(record.readers));
  std::wmemcpy(record.mapping_name, next.mapping_name, kMaxNameChars);
  std::wmemcpy(record.event_name, next.event_name, kMaxNameChars);
  std::atomic_thread_fence(std::memory_order_release);
  volatileStore64(record.sequence, nextSequence == 0u ? 2u : nextSequence);
  return true;
}

bool readControlRecord(const ControlRecord &record, ControlRecord &out) {
  const uint64_t before = volatileLoad64(record.sequence);
  std::atomic_thread_fence(std::memory_order_acquire);
  if ((before & 1u) != 0u || before == 0u) {
    return false;
  }
  out = record;
  std::atomic_thread_fence(std::memory_order_acquire);
  const uint64_t after = volatileLoad64(record.sequence);
  return before == after && (after & 1u) == 0u && out.magic == kControlMagic &&
         out.version == kLayoutVersion &&
         out.owner != static_cast<uint32_t>(LayoutOwner::Unknown) &&
         out.capacity_bytes != 0u && out.mapping_name[0] != L'\0' &&
         out.event_name[0] != L'\0';
}

bool updateReaderSlot(ControlRecord &record, uint32_t pid, uint64_t nowQpc) {
  if (pid == 0u || nowQpc == 0u) {
    return false;
  }
  for (uint32_t i = 0; i < kReaderSlotCount; ++i) {
    if (record.readers[i].pid == pid) {
      record.readers[i].last_seen_qpc = nowQpc;
      return true;
    }
  }
  uint32_t selected = kReaderSlotCount;
  uint64_t oldest = UINT64_MAX;
  for (uint32_t i = 0; i < kReaderSlotCount; ++i) {
    if (record.readers[i].pid == 0u) {
      selected = i;
      break;
    }
    if (record.readers[i].last_seen_qpc < oldest) {
      oldest = record.readers[i].last_seen_qpc;
      selected = i;
    }
  }
  if (selected >= kReaderSlotCount) {
    return false;
  }
  record.readers[selected].pid = pid;
  record.readers[selected].reserved0 = 0u;
  record.readers[selected].last_seen_qpc = nowQpc;
  return true;
}

void clearReaderSlot(ControlRecord &record, uint32_t pid) {
  if (pid == 0u) {
    return;
  }
  for (uint32_t i = 0; i < kReaderSlotCount; ++i) {
    if (record.readers[i].pid == pid) {
      record.readers[i] = ReaderSlot{};
    }
  }
}

uint64_t countLiveReaders(const ControlRecord &record,
                          uint64_t nowQpc,
                          uint64_t staleTicks,
                          bool (*pidAlive)(uint32_t pid)) {
  uint64_t count = 0u;
  for (uint32_t i = 0; i < kReaderSlotCount; ++i) {
    const ReaderSlot &slot = record.readers[i];
    if (slot.pid == 0u || slot.last_seen_qpc == 0u) {
      continue;
    }
    if (nowQpc > slot.last_seen_qpc + staleTicks) {
      continue;
    }
    if (pidAlive != nullptr && !pidAlive(slot.pid)) {
      continue;
    }
    ++count;
  }
  return count;
}

void bgraToNv12(const uint8_t *bgra,
                uint32_t width,
                uint32_t height,
                uint8_t *nv12,
                size_t nv12Size) {
  if (bgra == nullptr || nv12 == nullptr ||
      nv12Size < bytesPerFrame(width, height, PixelFormat::Nv12)) {
    return;
  }
  const size_t yPlaneBytes = static_cast<size_t>(width) * height;
  uint8_t *yPlane = nv12;
  uint8_t *uvPlane = nv12 + yPlaneBytes;
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      yPlane[static_cast<size_t>(y) * width + x] =
          lumaFromBgra(bgra + (static_cast<size_t>(y) * width + x) * 4u);
    }
  }
  const uint32_t chromaHeight = height / 2u;
  for (uint32_t y = 0; y < chromaHeight; ++y) {
    for (uint32_t x = 0; x + 1u < width; x += 2u) {
      uint8_t u = 128u;
      uint8_t v = 128u;
      chromaFromBgra2x2(bgra, width, height, x, y * 2u, u, v);
      const size_t offset = static_cast<size_t>(y) * width + x;
      uvPlane[offset] = u;
      uvPlane[offset + 1u] = v;
    }
  }
}

}  // namespace broadify::vcam_shm
