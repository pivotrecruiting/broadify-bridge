#include "preview/vcam_shm_layout.h"
#include "preview/vcam_shm_ring_win.h"
#include "util/pixel_swizzle.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <string>
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

void testCreatorPublishReaderCopy() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamServiceRingCtest-" +
      std::to_wstring(GetCurrentProcessId());
  VcamShmRingWin creator;
  const VcamShmCreateResult created =
      creator.createWithControlName(64, 36, 30, 11u, controlName, false);
  CHECK(created.ok);
  CHECK(!created.globalNamespace);

  std::vector<uint8_t> bgra(64u * 36u * 4u, 123u);
  CHECK(creator.publishBgra(64, 36, bgra.data(), bgra.size(), 0u));

  HANDLE control = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE,
                                    controlName.c_str());
  CHECK(control != nullptr);
  void *controlMemory = MapViewOfFile(control, FILE_MAP_READ | FILE_MAP_WRITE,
                                      0, 0, sizeof(ControlRecord));
  CHECK(controlMemory != nullptr);
  auto *controlRecord = static_cast<ControlRecord *>(controlMemory);
  ControlRecord record;
  CHECK(readControlRecord(*controlRecord, record));
  CHECK(validateServiceControl(record));
  CHECK(record.capacity_bytes == maxServiceRingBytes());

  HANDLE stream = OpenFileMappingW(FILE_MAP_READ, FALSE, record.mapping_name);
  CHECK(stream != nullptr);
  void *streamMemory = MapViewOfFile(stream, FILE_MAP_READ, 0, 0,
                                     static_cast<size_t>(record.capacity_bytes));
  CHECK(streamMemory != nullptr);
  CHECK(validateServiceRing(streamMemory, static_cast<size_t>(record.capacity_bytes)));
  CopiedFrame copied;
  CHECK(copyNewestFrame(streamMemory, static_cast<size_t>(record.capacity_bytes),
                        copied));
  CHECK(copied.width == 64u);
  CHECK(copied.height == 36u);
  CHECK(copied.data == bgra);

  UnmapViewOfFile(streamMemory);
  CloseHandle(stream);
  UnmapViewOfFile(controlMemory);
  CloseHandle(control);
}

void testPublishRgbaAsBgraMatchesTwoPass() {
  const std::wstring controlName =
      L"Local\\BroadifyVcamServiceRingSwizzleCtest-" +
      std::to_wstring(GetCurrentProcessId());
  VcamShmRingWin creator;
  const VcamShmCreateResult created =
      creator.createWithControlName(17, 9, 30, 12u, controlName, false);
  CHECK(created.ok);

  std::vector<uint8_t> rgba(17u * 9u * 4u);
  for (size_t i = 0; i < rgba.size(); ++i) {
    rgba[i] = static_cast<uint8_t>((i * 19u + 7u) & 0xffu);
  }
  std::vector<uint8_t> expected(rgba.size());
  swizzleRgbaToBgra(rgba.data(), expected.data(), rgba.size() / 4u);
  CHECK(creator.publishRgbaAsBgra(17, 9, rgba.data(), 17u * 4u, 0u));

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
  CHECK(copied.data == expected);

  UnmapViewOfFile(streamMemory);
  CloseHandle(stream);
  UnmapViewOfFile(controlMemory);
  CloseHandle(control);
}

void testServiceOwnedZeroGeometryOpenPublishValidate() {
  const std::wstring controlName = controlMappingName(false);
  const std::wstring streamName = serviceStreamMappingName(false);
  const std::wstring eventName = serviceStreamEventName(false);
  const size_t bytes = maxServiceRingBytes();
  LARGE_INTEGER size{};
  size.QuadPart = static_cast<LONGLONG>(bytes);
  HANDLE stream = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
                                     PAGE_READWRITE, size.HighPart,
                                     size.LowPart, streamName.c_str());
  CHECK(stream != nullptr);
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, eventName.c_str());
  CHECK(event != nullptr);
  HANDLE control = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
                                      PAGE_READWRITE, 0,
                                      static_cast<DWORD>(sizeof(ControlRecord)),
                                      controlName.c_str());
  CHECK(control != nullptr);
  void *streamMemory =
      MapViewOfFile(stream, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, bytes);
  CHECK(streamMemory != nullptr);
  void *controlMemory = MapViewOfFile(control, FILE_MAP_READ | FILE_MAP_WRITE,
                                      0, 0, sizeof(ControlRecord));
  CHECK(controlMemory != nullptr);
  CHECK(initializeServiceRing(streamMemory, bytes, 100u));
  auto *controlRecord = static_cast<ControlRecord *>(controlMemory);
  *controlRecord = ControlRecord{};
  controlRecord->magic = kControlMagic;
  controlRecord->version = kLayoutVersion;
  controlRecord->owner = static_cast<uint32_t>(LayoutOwner::Service);
  controlRecord->sequence = 2u;
  controlRecord->capacity_bytes = bytes;
  wcsncpy_s(controlRecord->mapping_name, streamName.c_str(),
            kMaxNameChars - 1u);
  wcsncpy_s(controlRecord->event_name, eventName.c_str(), kMaxNameChars - 1u);
  CHECK(validateServiceControl(*controlRecord));
  CHECK(validateServiceRing(streamMemory, bytes));

  VcamShmRingWin helper;
  const VcamShmCreateResult opened =
      helper.openServiceRing(64, 36, 30, 21u, false);
  CHECK(opened.ok);
  CHECK(!opened.globalNamespace);
  std::vector<uint8_t> bgra(64u * 36u * 4u, 231u);
  CHECK(helper.publishBgra(64, 36, bgra.data(), bgra.size(), 0u));

  ControlRecord record;
  CHECK(readControlRecord(*controlRecord, record));
  CHECK(validateServiceControl(record));
  CHECK(validateServiceRing(streamMemory, bytes));
  CopiedFrame copied;
  CHECK(copyNewestFrame(streamMemory, bytes, copied));
  CHECK(copied.width == 64u);
  CHECK(copied.height == 36u);
  CHECK(copied.data == bgra);

  helper.close();
  UnmapViewOfFile(controlMemory);
  UnmapViewOfFile(streamMemory);
  CloseHandle(control);
  CloseHandle(event);
  CloseHandle(stream);
}

void testRejectWrongMagicAndCapacity() {
  std::vector<uint8_t> memory(maxServiceRingBytes());
  CHECK(initializeServiceRing(memory.data(), memory.size(), 100u));
  CHECK(validateServiceRing(memory.data(), memory.size()));
  auto *header = reinterpret_cast<RingHeader *>(memory.data());
  header->magic = 0u;
  CHECK(!validateServiceRing(memory.data(), memory.size()));
  header->magic = kRingMagic;
  header->capacity_bytes = 64u;
  CHECK(!validateServiceRing(memory.data(), memory.size()));
}

int main() {
  testCreatorPublishReaderCopy();
  testPublishRgbaAsBgraMatchesTwoPass();
  testServiceOwnedZeroGeometryOpenPublishValidate();
  testRejectWrongMagicAndCapacity();
  std::cout << "vcam_shm_service_ring_test passed\n";
  return 0;
}
