#include "preview/vcam_shm_layout.h"
#include "preview/vcam_shm_publisher.h"
#include "preview/vcam_shm_ring_win.h"
#include "util/pixel_swizzle.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <chrono>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::meeting;
using namespace broadify::vcam_shm;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

namespace {

std::vector<uint8_t> rgbaFrame(uint32_t width,
                               uint32_t height,
                               uint8_t seed) {
  std::vector<uint8_t> frame(static_cast<size_t>(width) * height * 4u);
  for (size_t i = 0; i < frame.size(); ++i) {
    frame[i] = static_cast<uint8_t>((i * 13u + seed) & 0xffu);
  }
  return frame;
}

CopiedFrame copyNewestFromControl(const std::wstring &controlName) {
  HANDLE control = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE,
                                    controlName.c_str());
  CHECK(control != nullptr);
  void *controlMemory = MapViewOfFile(control, FILE_MAP_READ | FILE_MAP_WRITE,
                                      0, 0, sizeof(ControlRecord));
  CHECK(controlMemory != nullptr);
  auto *controlRecord = static_cast<ControlRecord *>(controlMemory);
  ControlRecord record;
  CHECK(readControlRecord(*controlRecord, record));
  HANDLE stream = OpenFileMappingW(FILE_MAP_READ, FALSE, record.mapping_name);
  CHECK(stream != nullptr);
  void *streamMemory = MapViewOfFile(stream, FILE_MAP_READ, 0, 0,
                                     static_cast<size_t>(record.capacity_bytes));
  CHECK(streamMemory != nullptr);
  CopiedFrame copied;
  CHECK(copyNewestFrame(streamMemory, static_cast<size_t>(record.capacity_bytes),
                        copied));
  UnmapViewOfFile(streamMemory);
  CloseHandle(stream);
  UnmapViewOfFile(controlMemory);
  CloseHandle(control);
  return copied;
}

void testNoPublishWhenInactive() {
  VcamShmPublisher publisher;
  const std::vector<uint8_t> frame = rgbaFrame(4, 4, 1);
  CHECK(!publisher.submitRgba(4, 4, frame.data(), frame.size(), 0u));
  publisher.start(nullptr);
  CHECK(!publisher.submitRgba(4, 4, frame.data(), frame.size(), 0u));
  publisher.stop();
}

void testStopJoin() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamPublisherStopCtest-" +
      std::to_wstring(GetCurrentProcessId());
  VcamShmRingWin ring;
  CHECK(ring.createWithControlName(8, 4, 30, 31u, controlName, false).ok);
  VcamShmPublisher publisher;
  publisher.start(&ring);
  const std::vector<uint8_t> frame = rgbaFrame(8, 4, 2);
  CHECK(publisher.submitRgba(8, 4, frame.data(), frame.size(), 0u));
  publisher.stop();
  CHECK(!publisher.submitRgba(8, 4, frame.data(), frame.size(), 0u));
}

void testLatestWinsDropsPendingFrame() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamPublisherLatestCtest-" +
      std::to_wstring(GetCurrentProcessId());
  VcamShmRingWin ring;
  CHECK(ring.createWithControlName(8, 4, 30, 32u, controlName, false).ok);
  VcamShmPublisher publisher;
  publisher.setPublishDelayForTesting(std::chrono::milliseconds(120));
  publisher.start(&ring);

  const std::vector<uint8_t> first = rgbaFrame(8, 4, 10);
  const std::vector<uint8_t> second = rgbaFrame(8, 4, 20);
  const std::vector<uint8_t> newest = rgbaFrame(8, 4, 30);
  CHECK(publisher.submitRgba(8, 4, first.data(), first.size(), 0u));
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(publisher.submitRgba(8, 4, second.data(), second.size(), 0u));
  CHECK(publisher.submitRgba(8, 4, newest.data(), newest.size(), 0u));
  std::this_thread::sleep_for(std::chrono::milliseconds(300));

  std::vector<uint8_t> expected(newest.size());
  swizzleRgbaToBgra(newest.data(), expected.data(), newest.size() / 4u);
  const CopiedFrame copied = copyNewestFromControl(controlName);
  CHECK(copied.data == expected);
  CHECK(publisher.metrics().droppedFrames > 0u);
  publisher.stop();
}

}  // namespace

int main() {
  testNoPublishWhenInactive();
  testStopJoin();
  testLatestWinsDropsPendingFrame();
  std::cout << "vcam_shm_publisher_test passed\n";
  return 0;
}
