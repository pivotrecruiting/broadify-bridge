#include "preview/vcam_shm_layout.h"
#include "preview/vcam_shm_ring_win.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <cstdlib>
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
  CHECK(record.capacity_bytes >= ringBytesFor(64, 36, PixelFormat::Bgra8));

  HANDLE stream = OpenFileMappingW(FILE_MAP_READ, FALSE, record.mapping_name);
  CHECK(stream != nullptr);
  void *streamMemory = MapViewOfFile(stream, FILE_MAP_READ, 0, 0,
                                     static_cast<size_t>(record.capacity_bytes));
  CHECK(streamMemory != nullptr);
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
  testRejectWrongMagicAndCapacity();
  std::cout << "vcam_shm_service_ring_test passed\n";
  return 0;
}
