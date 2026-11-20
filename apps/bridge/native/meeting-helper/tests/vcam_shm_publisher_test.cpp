#include "preview/vcam_shm_layout.h"
#include "preview/vcam_shm_publisher.h"
#include "preview/vcam_shm_ring_win.h"
#include "util/frame_fit.h"
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
#include <cstring>
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
  CHECK(submitElapsed <= std::chrono::milliseconds(10));
  CHECK(publisher.metrics().droppedFrames > 0u);
  {
    std::lock_guard<std::mutex> lock(gateMutex);
    releasePublish = true;
  }
  gateCv.notify_all();
  publisher.stop();
}

void testSubmitBufferKeepsProgramFrameAndPublishesContent() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamPublisherVectorCtest-" +
      std::to_wstring(GetCurrentProcessId());
  VcamShmRingWin ring;
  CHECK(ring.createWithControlName(8, 4, 30, 34u, controlName, false).ok);
  VcamShmPublisher publisher;
  publisher.start(&ring);

  std::vector<uint8_t> programFrame = rgbaFrame(8, 4, 40);
  const std::vector<uint8_t> original = programFrame;
  std::vector<uint8_t> submitFrame(programFrame.size());
  std::memcpy(submitFrame.data(), programFrame.data(), programFrame.size());
  CHECK(publisher.submitRgba(8, 4, submitFrame, 0u));
  CHECK(programFrame == original);

  std::vector<uint8_t> expected(original.size());
  swizzleRgbaToBgra(original.data(), expected.data(), expected.size() / 4u);
  waitNewestEquals(controlName, expected);
  publisher.stop();
}

// A portrait program frame (1080x1920) is pillarboxed into the 16:9 ring on
// the publisher thread: the ring is created at 1920x1080 and receives the
// program between opaque black bars. Without the fit publishRgbaAsBgra would
// reject the frame (geometry mismatch) and the virtual camera would freeze.
void testPortraitFrameIsPillarboxedIntoLandscapeRing() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamPublisherPortraitCtest-" +
      std::to_wstring(GetCurrentProcessId());
  constexpr uint32_t kProgramWidth = 1080;
  constexpr uint32_t kProgramHeight = 1920;
  const FrameGeometry ringGeometry =
      vcamOutputGeometry(kProgramWidth, kProgramHeight);
  CHECK(ringGeometry.width == 1920u);
  CHECK(ringGeometry.height == 1080u);
  VcamShmRingWin ring;
  CHECK(ring.createWithControlName(ringGeometry.width, ringGeometry.height, 30,
                                   35u, controlName, false)
            .ok);
  VcamShmPublisher publisher;
  publisher.start(&ring);

  // Solid RGBA (200, 40, 90, 255): expected in the ring as BGRA (90, 40, 200).
  std::vector<uint8_t> programFrame(static_cast<size_t>(kProgramWidth) *
                                    kProgramHeight * 4u);
  for (size_t offset = 0; offset < programFrame.size(); offset += 4u) {
    programFrame[offset + 0u] = 200u;
    programFrame[offset + 1u] = 40u;
    programFrame[offset + 2u] = 90u;
    programFrame[offset + 3u] = 255u;
  }
  CHECK(publisher.submitRgba(kProgramWidth, kProgramHeight, programFrame, 0u));

  const size_t expectedBytes =
      static_cast<size_t>(ringGeometry.width) * ringGeometry.height * 4u;
  const FitRect rect = containRect(kProgramWidth, kProgramHeight,
                                   ringGeometry.width, ringGeometry.height);
  CHECK(rect.x == 656u && rect.width == 608u && rect.height == 1080u);
  CopiedFrame copied;
  bool received = false;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (std::chrono::steady_clock::now() < deadline) {
    if (tryCopyNewestFromControl(controlName, copied) &&
        copied.data.size() == expectedBytes) {
      received = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK(received);
  CHECK(copied.width == ringGeometry.width);
  CHECK(copied.height == ringGeometry.height);
  for (uint32_t y = 0; y < ringGeometry.height; y += 119u) {
    for (uint32_t x = 0; x < ringGeometry.width; ++x) {
      const uint8_t *pixel =
          copied.data.data() +
          (static_cast<size_t>(y) * ringGeometry.width + x) * 4u;
      if (x >= rect.x && x < rect.x + rect.width) {
        CHECK(pixel[0] == 90u && pixel[1] == 40u && pixel[2] == 200u &&
              pixel[3] == 255u);
      } else {
        CHECK(pixel[0] == 0u && pixel[1] == 0u && pixel[2] == 0u &&
              pixel[3] == 255u);
      }
    }
  }
  publisher.stop();
}

}  // namespace

int main() {
  testNoPublishWhenInactive();
  testStopJoin();
  testLatestWinsDropsPendingFrame();
  testSubmitIsBoundedWhileRingPublishIsLocked();
  testSubmitBufferKeepsProgramFrameAndPublishesContent();
  testPortraitFrameIsPillarboxedIntoLandscapeRing();
  std::cout << "vcam_shm_publisher_test passed\n";
  return 0;
}
