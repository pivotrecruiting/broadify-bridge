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
#include <condition_variable>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <mutex>
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

bool tryCopyNewestFromControl(const std::wstring &controlName,
                              CopiedFrame &copied) {
  HANDLE control = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE,
                                    controlName.c_str());
  if (control == nullptr) {
    return false;
  }
  void *controlMemory = MapViewOfFile(control, FILE_MAP_READ | FILE_MAP_WRITE,
                                      0, 0, sizeof(ControlRecord));
  if (controlMemory == nullptr) {
    CloseHandle(control);
    return false;
  }
  auto *controlRecord = static_cast<ControlRecord *>(controlMemory);
  ControlRecord record;
  if (!readControlRecord(*controlRecord, record)) {
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    return false;
  }
  HANDLE stream = OpenFileMappingW(FILE_MAP_READ, FALSE, record.mapping_name);
  if (stream == nullptr) {
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    return false;
  }
  void *streamMemory = MapViewOfFile(stream, FILE_MAP_READ, 0, 0,
                                     static_cast<size_t>(record.capacity_bytes));
  if (streamMemory == nullptr) {
    CloseHandle(stream);
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    return false;
  }
  const bool ok = copyNewestFrame(
      streamMemory, static_cast<size_t>(record.capacity_bytes), copied);
  UnmapViewOfFile(streamMemory);
  CloseHandle(stream);
  UnmapViewOfFile(controlMemory);
  CloseHandle(control);
  return ok;
}

void waitNewestEquals(const std::wstring &controlName,
                      const std::vector<uint8_t> &expected) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (std::chrono::steady_clock::now() < deadline) {
    CopiedFrame copied;
    if (tryCopyNewestFromControl(controlName, copied) &&
        copied.data == expected) {
      return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK(false);
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
  std::mutex gateMutex;
  std::condition_variable gateCv;
  bool publishEntered = false;
  bool releasePublish = false;
  bool gateUsed = false;
  ring.setPublishGateForTesting([&] {
    std::unique_lock<std::mutex> lock(gateMutex);
    if (gateUsed) {
      return;
    }
    gateUsed = true;
    publishEntered = true;
    gateCv.notify_all();
    gateCv.wait(lock, [&] { return releasePublish; });
  });
  publisher.start(&ring);

  const std::vector<uint8_t> first = rgbaFrame(8, 4, 10);
  const std::vector<uint8_t> second = rgbaFrame(8, 4, 20);
  const std::vector<uint8_t> newest = rgbaFrame(8, 4, 30);
  CHECK(publisher.submitRgba(8, 4, first.data(), first.size(), 0u));
  {
    std::unique_lock<std::mutex> lock(gateMutex);
    CHECK(gateCv.wait_for(lock, std::chrono::seconds(3),
                          [&] { return publishEntered; }));
  }
  CHECK(publisher.submitRgba(8, 4, second.data(), second.size(), 0u));
  CHECK(publisher.submitRgba(8, 4, newest.data(), newest.size(), 0u));
  {
    std::lock_guard<std::mutex> lock(gateMutex);
    releasePublish = true;
  }
  gateCv.notify_all();

  std::vector<uint8_t> expected(newest.size());
  swizzleRgbaToBgra(newest.data(), expected.data(), newest.size() / 4u);
  waitNewestEquals(controlName, expected);
  CHECK(publisher.metrics().droppedFrames > 0u);
  publisher.stop();
}

void testSubmitIsBoundedWhileRingPublishIsLocked() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamPublisherBoundedCtest-" +
      std::to_wstring(GetCurrentProcessId());
  constexpr uint32_t width = 1920;
  constexpr uint32_t height = 1080;
  VcamShmRingWin ring;
  CHECK(ring.createWithControlName(width, height, 30, 33u, controlName, false)
            .ok);
  VcamShmPublisher publisher;
  publisher.start(&ring);

  std::vector<uint8_t> warmup = rgbaFrame(width, height, 1);
  CHECK(publisher.submitRgba(width, height, warmup, 0u));
  std::vector<uint8_t> warmupExpected(static_cast<size_t>(width) * height * 4u);
  const std::vector<uint8_t> warmupRgba = rgbaFrame(width, height, 1);
  swizzleRgbaToBgra(warmupRgba.data(), warmupExpected.data(),
                    warmupExpected.size() / 4u);
  waitNewestEquals(controlName, warmupExpected);

  std::mutex gateMutex;
  std::condition_variable gateCv;
  bool publishEntered = false;
  bool releasePublish = false;
  bool gateUsed = false;
  ring.setPublishGateForTesting([&] {
    std::unique_lock<std::mutex> lock(gateMutex);
    if (gateUsed) {
      return;
    }
    gateUsed = true;
    publishEntered = true;
    gateCv.notify_all();
    gateCv.wait(lock, [&] { return releasePublish; });
  });

  std::vector<uint8_t> first = rgbaFrame(width, height, 2);
  std::vector<uint8_t> second = rgbaFrame(width, height, 3);
  std::vector<uint8_t> newest = rgbaFrame(width, height, 4);
  CHECK(publisher.submitRgba(width, height, first, 0u));
  {
    std::unique_lock<std::mutex> lock(gateMutex);
    CHECK(gateCv.wait_for(lock, std::chrono::seconds(3),
                          [&] { return publishEntered; }));
  }
  const auto submitStart = std::chrono::steady_clock::now();
  CHECK(publisher.submitRgba(width, height, second, 0u));
  CHECK(publisher.submitRgba(width, height, newest, 0u));
  const auto submitElapsed =
      std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - submitStart);
  CHECK(submitElapsed < std::chrono::milliseconds(1));
  CHECK(publisher.metrics().droppedFrames > 0u);
  {
    std::lock_guard<std::mutex> lock(gateMutex);
    releasePublish = true;
  }
  gateCv.notify_all();
  publisher.stop();
}

}  // namespace

int main() {
  testNoPublishWhenInactive();
  testStopJoin();
  testLatestWinsDropsPendingFrame();
  testSubmitIsBoundedWhileRingPublishIsLocked();
  std::cout << "vcam_shm_publisher_test passed\n";
  return 0;
}
