#include "preview/vcam_shm_layout.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstdint>
#include <iostream>
#include <thread>
#include <vector>

using namespace broadify::vcam_shm;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

void testRingNewestEvenRule() {
  const uint32_t width = 2;
  const uint32_t height = 2;
  std::vector<uint8_t> memory(ringBytesFor(width, height, PixelFormat::Bgra8));
  CHECK(initializeRing(memory.data(), memory.size(), width, height, 30, 1,
                        PixelFormat::Bgra8, 123, 7, 100));
  std::vector<uint8_t> first(bytesPerFrame(width, height, PixelFormat::Bgra8), 1);
  std::vector<uint8_t> second(first.size(), 2);
  CHECK(publishFrame(memory.data(), memory.size(), 1, 101, first.data(),
                      first.size(), 101));
  CHECK(publishFrame(memory.data(), memory.size(), 2, 102, second.data(),
                      second.size(), 102));
  CopiedFrame frame;
  CHECK(copyNewestFrame(memory.data(), memory.size(), frame));
  CHECK(frame.sequence == 4);
  CHECK(frame.capture_qpc == 102);
  CHECK(frame.data == second);
  CHECK(!publishFrame(memory.data(), memory.size(), 3, 103, second.data(),
                       second.size() - 1u, 103));
}

void testRingRejectsTornSlot() {
  const uint32_t width = 2;
  const uint32_t height = 2;
  std::vector<uint8_t> memory(ringBytesFor(width, height, PixelFormat::Bgra8));
  CHECK(initializeRing(memory.data(), memory.size(), width, height, 30, 1,
                        PixelFormat::Bgra8, 123, 7, 100));
  SlotHeader *slot = slotHeader(memory.data(), memory.size(), 0);
  uint8_t *data = slotData(memory.data(), memory.size(), 0);
  CHECK(slot != nullptr);
  CHECK(data != nullptr);
  slot->sequence = 3;
  slot->capture_qpc = 101;
  slot->size =
      static_cast<uint32_t>(bytesPerFrame(width, height, PixelFormat::Bgra8));
  std::fill(data, data + slot->size, 9);
  CopiedFrame frame;
  CHECK(!copyNewestFrame(memory.data(), memory.size(), frame));
}

void testRingRejectsAttackerControlledHeaderFields() {
  const uint32_t width = 4;
  const uint32_t height = 4;
  const size_t bytes = ringBytesFor(width, height, PixelFormat::Bgra8);
  std::vector<uint8_t> memory(bytes);
  CHECK(initializeRing(memory.data(), memory.size(), width, height, 30, 1,
                       PixelFormat::Bgra8, 123, 7, 100));
  std::vector<uint8_t> frame(bytesPerFrame(width, height, PixelFormat::Bgra8),
                             17u);
  CHECK(publishFrame(memory.data(), memory.size(), 1, 101, frame.data(),
                     frame.size(), 101));

  auto *header = reinterpret_cast<RingHeader *>(memory.data());
  const uint32_t expectedStride = header->slot_stride;
  CopiedFrame copied;
  header->slot_stride = expectedStride + 64u;
  CHECK(!copyNewestFrame(memory.data(), memory.size(), copied));
  CHECK(!publishFrame(memory.data(), memory.size(), 2, 102, frame.data(),
                      frame.size(), 102));

  header->slot_stride = expectedStride;
  header->slot_count = kSlotCount + 1u;
  CHECK(!copyNewestFrame(memory.data(), memory.size(), copied));
  CHECK(!publishFrame(memory.data(), memory.size(), 2, 102, frame.data(),
                      frame.size(), 102));

  header->slot_count = kSlotCount;
  CHECK(!copyNewestFrame(memory.data(), bytes - 1u, copied));
  CHECK(!publishFrame(memory.data(), bytes - 1u, 2, 102, frame.data(),
                      frame.size(), 102));
}

void testRingRejectsInterleavedWriterTornRead() {
  const uint32_t width = 512;
  const uint32_t height = 512;
  std::vector<uint8_t> memory(ringBytesFor(width, height, PixelFormat::Bgra8));
  CHECK(initializeRing(memory.data(), memory.size(), width, height, 30, 1,
                        PixelFormat::Bgra8, 123, 7, 100));
  std::vector<uint8_t> first(bytesPerFrame(width, height, PixelFormat::Bgra8), 7);
  std::vector<uint8_t> second(first.size(), 9);
  CHECK(publishFrame(memory.data(), memory.size(), 1, 101, first.data(),
                      first.size(), 101));

  std::atomic<bool> running{true};
  std::thread writer([&]() {
    uint64_t sequence = 2;
    while (running.load()) {
      const uint64_t secondSequence = sequence++;
      publishFrame(memory.data(), memory.size(), secondSequence,
                   100 + secondSequence, second.data(), second.size(),
                   100 + secondSequence);
      const uint64_t firstSequence = sequence++;
      publishFrame(memory.data(), memory.size(), firstSequence,
                   100 + firstSequence, first.data(), first.size(),
                   100 + firstSequence);
    }
  });

  for (int i = 0; i < 200; ++i) {
    CopiedFrame frame;
    if (copyNewestFrame(memory.data(), memory.size(), frame)) {
      CHECK(std::all_of(frame.data.begin(), frame.data.end(), [&](uint8_t value) {
        return value == frame.data.front();
      }));
    }
  }
  running.store(false);
  writer.join();
}

void testControlGenerationChange() {
  ControlRecord record;
  ControlRecord next;
  CHECK(initializeControlRecord(
      next, L"Global\\BroadifyVcam-1-2", L"Global\\BroadifyVcamFrame-1-2",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 3, 900));
  CHECK(writeControlRecord(record, next));
  ControlRecord read;
  CHECK(readControlRecord(record, read));
  CHECK(read.writer_generation == 3);

  CHECK(initializeControlRecord(
      next, L"Global\\BroadifyVcam-1-3", L"Global\\BroadifyVcamFrame-1-3",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 4, 901));
  CHECK(writeControlRecord(record, next));
  CHECK(readControlRecord(record, read));
  CHECK(read.writer_generation == 4);
  CHECK(std::wstring(read.mapping_name) == L"Global\\BroadifyVcam-1-3");
}

bool pidAliveExcept13(uint32_t pid) {
  return pid != 13u;
}

void testControlReaderLivenessDerivation() {
  ControlRecord record;
  ControlRecord next;
  CHECK(initializeControlRecord(
      next, L"Global\\BroadifyVcam-1-2", L"Global\\BroadifyVcamFrame-1-2",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 3, 900));
  CHECK(writeControlRecord(record, next));
  CHECK(updateReaderSlot(record, 11, 1000));
  CHECK(updateReaderSlot(record, 12, 950));
  CHECK(updateReaderSlot(record, 13, 1000));
  CHECK(updateReaderSlot(record, 14, 10));
  CHECK(countLiveReaders(record, 1000, 100, pidAliveExcept13) == 2);
  clearReaderSlot(record, 12);
  CHECK(countLiveReaders(record, 1000, 100, pidAliveExcept13) == 1);
}

void testControlRoundTrip() {
  ControlRecord record;
  ControlRecord next;
  CHECK(initializeControlRecord(
      next, L"Global\\BroadifyVcam-1-2", L"Global\\BroadifyVcamFrame-1-2",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 3, 900));
  CHECK(writeControlRecord(record, next));
  record.reader_count = 2;
  ControlRecord read;
  CHECK(readControlRecord(record, read));
  CHECK(read.width == 1920);
  CHECK(read.height == 1080);
  CHECK(read.writer_generation == 3);
  CHECK(read.reader_count == 2);
  CHECK(std::wstring(read.mapping_name) == L"Global\\BroadifyVcam-1-2");

  next.writer_generation = 4;
  next.heartbeat_qpc = 901;
  CHECK(writeControlRecord(record, next));
  CHECK(readControlRecord(record, read));
  CHECK(read.writer_generation == 4);
  CHECK(read.heartbeat_qpc == 901);

  record.sequence |= 1u;
  CHECK(!readControlRecord(record, read));
}

void testServiceRingValidation() {
  const size_t bytes = maxServiceRingBytes();
  std::vector<uint8_t> memory(bytes);
  CHECK(initializeServiceRing(memory.data(), memory.size(), 700));
  CHECK(validateServiceRing(memory.data(), memory.size()));
  auto *header = reinterpret_cast<RingHeader *>(memory.data());
  CHECK(header->owner == static_cast<uint32_t>(LayoutOwner::Service));
  CHECK(header->capacity_bytes == bytes);
  CHECK(header->writer_generation == 0u);
  header->capacity_bytes = bytes - 1u;
  CHECK(!validateServiceRing(memory.data(), memory.size()));
  header->capacity_bytes = bytes;
  header->slot_stride = 1u;
  header->slot_count = 99u;
  CHECK(validateServiceRing(memory.data(), memory.size()));
}

void testServiceControlValidation() {
  ControlRecord record;
  CHECK(initializeControlRecord(
      record, L"Global\\BroadifyVcam-stream", L"Global\\BroadifyVcam-frame",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 3, 900));
  record.owner = static_cast<uint32_t>(LayoutOwner::Service);
  record.capacity_bytes = maxServiceRingBytes();
  CHECK(validateServiceControl(record));
  record.magic = 0u;
  CHECK(!validateServiceControl(record));
  record.magic = kControlMagic;
  record.capacity_bytes = 1u;
  CHECK(!validateServiceControl(record));
  record.capacity_bytes = maxServiceRingBytes();
  record.width = kMaxServiceWidth + 1u;
  CHECK(!validateServiceControl(record));
  record.width = kMaxServiceWidth;
  record.height = kMaxServiceHeight + 1u;
  CHECK(!validateServiceControl(record));
}

void testNamesAndSddl() {
  const std::wstring token = makeStreamToken(123, 456);
  CHECK(token == L"123-456");
  CHECK(streamMappingName(token, true) == L"Global\\BroadifyVcam-123-456");
  CHECK(streamEventName(token, false) == L"Local\\BroadifyVcamFrame-123-456");
  CHECK(controlMappingName(true) == L"Global\\BroadifyVcam-control");
  CHECK(serviceStreamMappingName(true) == L"Global\\BroadifyVcam-stream");
  CHECK(serviceStreamEventName(false) == L"Local\\BroadifyVcam-frame");
  const std::wstring streamSddl = streamSecurityDescriptorSddl();
  const std::wstring controlSddl = controlSecurityDescriptorSddl();
  CHECK(streamSddl.find(L"GA;;;LS") != std::wstring::npos);
  CHECK(streamSddl.find(L"GRGWGX;;;IU") != std::wstring::npos);
  CHECK(streamSddl.find(L"GRGWGX;;;AU") != std::wstring::npos);
  CHECK(controlSddl.find(L"GWGR;;;IU") != std::wstring::npos);
  CHECK(controlSddl.find(L"GWGR;;;AU") != std::wstring::npos);
}

void testBgraToNv12Reference() {
  const uint32_t width = 2;
  const uint32_t height = 2;
  const uint8_t bgra[] = {
      0, 0, 0, 255,
      255, 255, 255, 255,
      0, 0, 255, 255,
      255, 0, 0, 255,
  };
  std::vector<uint8_t> nv12(bytesPerFrame(width, height, PixelFormat::Nv12), 0);
  bgraToNv12(bgra, width, height, nv12.data(), nv12.size());
  CHECK(nv12.size() == 6);
  CHECK(nv12[0] == 16);
  CHECK(nv12[1] == 235);
  CHECK(nv12[2] == 82);
  CHECK(nv12[3] == 41);
  CHECK(nv12[4] == 147);
  CHECK(nv12[5] == 152);
}

int main() {
  testRingNewestEvenRule();
  testRingRejectsTornSlot();
  testRingRejectsAttackerControlledHeaderFields();
  testRingRejectsInterleavedWriterTornRead();
  testControlRoundTrip();
  testControlGenerationChange();
  testControlReaderLivenessDerivation();
  testServiceRingValidation();
  testServiceControlValidation();
  testNamesAndSddl();
  testBgraToNv12Reference();
  std::cout << "vcam_shm_layout_test passed\n";
  return 0;
}
