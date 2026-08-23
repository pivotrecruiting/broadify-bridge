#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace broadify::meeting {

constexpr uint32_t kBfrgMagic = 0x47524642u;
constexpr uint32_t kBfrgVersion1 = 1u;
constexpr uint32_t kBfrgVersion2 = 2u;
constexpr uint32_t kBfrgPixelFormatBgra8 = 2u;
constexpr size_t kBfrgHeaderV1Size = 32u;
constexpr size_t kBfrgHeaderV2Size = 40u;

struct BfrgRecordHeader {
  uint32_t version = kBfrgVersion2;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t pixelFormat = kBfrgPixelFormatBgra8;
  uint32_t payloadSize = 0;
  uint64_t sequence = 0;
  uint64_t captureNs = 0;
};

void writeBfrgHeaderV2(std::vector<uint8_t> &data,
                       size_t offset,
                       const BfrgRecordHeader &header);
bool readBfrgHeader(const uint8_t *data, size_t size, BfrgRecordHeader &header);

}  // namespace broadify::meeting
