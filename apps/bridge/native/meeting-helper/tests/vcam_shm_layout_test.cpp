#include "preview/vcam_shm_layout.h"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>

using namespace broadify::vcam_shm;

void testRingNewestEvenRule() {
  const uint32_t width = 2;
  const uint32_t height = 2;
  std::vector<uint8_t> memory(ringBytesFor(width, height, PixelFormat::Bgra8));
  assert(initializeRing(memory.data(), memory.size(), width, height, 30, 1,
                        PixelFormat::Bgra8, 123, 7, 100));
  std::vector<uint8_t> first(bytesPerFrame(width, height, PixelFormat::Bgra8), 1);
  std::vector<uint8_t> second(first.size(), 2);
  assert(publishFrame(memory.data(), memory.size(), 1, 101, first.data(),
                      first.size(), 101));
  assert(publishFrame(memory.data(), memory.size(), 2, 102, second.data(),
                      second.size(), 102));
  CopiedFrame frame;
  assert(copyNewestFrame(memory.data(), memory.size(), frame));
  assert(frame.sequence == 4);
  assert(frame.capture_qpc == 102);
  assert(frame.data == second);
  assert(!publishFrame(memory.data(), memory.size(), 3, 103, second.data(),
                       second.size() - 1u, 103));
}

void testControlRoundTrip() {
  ControlRecord record;
  ControlRecord next;
  assert(initializeControlRecord(
      next, L"Global\\BroadifyVcam-1-2", L"Global\\BroadifyVcamFrame-1-2",
      1920, 1080, 30, 1, PixelFormat::Bgra8, 42, 3, 900));
  assert(writeControlRecord(record, next));
  record.reader_count = 2;
  ControlRecord read;
  assert(readControlRecord(record, read));
  assert(read.width == 1920);
  assert(read.height == 1080);
  assert(read.writer_generation == 3);
  assert(read.reader_count == 2);
  assert(std::wstring(read.mapping_name) == L"Global\\BroadifyVcam-1-2");
}

void testNamesAndSddl() {
  const std::wstring token = makeStreamToken(123, 456);
  assert(token == L"123-456");
  assert(streamMappingName(token, true) == L"Global\\BroadifyVcam-123-456");
  assert(streamEventName(token, false) == L"Local\\BroadifyVcamFrame-123-456");
  const std::wstring sddl = securityDescriptorSddl();
  assert(sddl.find(L"LS") != std::wstring::npos);
  assert(sddl.find(L"BA") != std::wstring::npos);
  assert(sddl.find(L"OW") != std::wstring::npos);
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
  assert(nv12.size() == 6);
  assert(nv12[0] == 16);
  assert(nv12[1] == 235);
  assert(nv12[2] == 82);
  assert(nv12[3] == 41);
  assert(nv12[4] >= 127 && nv12[4] <= 129);
  assert(nv12[5] >= 127 && nv12[5] <= 129);
}

int main() {
  testRingNewestEvenRule();
  testControlRoundTrip();
  testNamesAndSddl();
  testBgraToNv12Reference();
  std::cout << "vcam_shm_layout_test passed\n";
  return 0;
}
