#include "preview/vcam_shm_layout.h"

#include <cstdlib>
#include <cstdint>
#include <iostream>
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

void testNamesAndSddl() {
  const std::wstring token = makeStreamToken(123, 456);
  CHECK(token == L"123-456");
  CHECK(streamMappingName(token, true) == L"Global\\BroadifyVcam-123-456");
  CHECK(streamEventName(token, false) == L"Local\\BroadifyVcamFrame-123-456");
  const std::wstring streamSddl = streamSecurityDescriptorSddl();
  const std::wstring controlSddl = controlSecurityDescriptorSddl();
  CHECK(streamSddl.find(L"GRGX;;;LS") != std::wstring::npos);
  CHECK(controlSddl.find(L"GWGR;;;LS") != std::wstring::npos);
  CHECK(controlSddl.find(L"BA") != std::wstring::npos);
  CHECK(controlSddl.find(L"OW") != std::wstring::npos);
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
  testControlRoundTrip();
  testNamesAndSddl();
  testBgraToNv12Reference();
  std::cout << "vcam_shm_layout_test passed\n";
  return 0;
}
