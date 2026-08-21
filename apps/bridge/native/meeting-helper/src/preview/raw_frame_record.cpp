#include "preview/raw_frame_record.h"

namespace broadify::meeting {
namespace {

void writeU32Le(std::vector<uint8_t> &data, size_t offset, uint32_t value) {
  data[offset + 0u] = static_cast<uint8_t>(value & 0xffu);
  data[offset + 1u] = static_cast<uint8_t>((value >> 8u) & 0xffu);
  data[offset + 2u] = static_cast<uint8_t>((value >> 16u) & 0xffu);
  data[offset + 3u] = static_cast<uint8_t>((value >> 24u) & 0xffu);
}

void writeU64Le(std::vector<uint8_t> &data, size_t offset, uint64_t value) {
  for (size_t i = 0; i < 8u; ++i) {
    data[offset + i] = static_cast<uint8_t>((value >> (i * 8u)) & 0xffu);
  }
}

uint32_t readU32Le(const uint8_t *data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8u) |
         (static_cast<uint32_t>(data[2]) << 16u) |
         (static_cast<uint32_t>(data[3]) << 24u);
}

uint64_t readU64Le(const uint8_t *data) {
  uint64_t value = 0;
  for (size_t i = 0; i < 8u; ++i) {
    value |= static_cast<uint64_t>(data[i]) << (i * 8u);
  }
  return value;
}

}  // namespace

void writeBfrgHeaderV2(std::vector<uint8_t> &data,
                       size_t offset,
                       const BfrgRecordHeader &header) {
  writeU32Le(data, offset + 0u, kBfrgMagic);
  writeU32Le(data, offset + 4u, kBfrgVersion2);
  writeU32Le(data, offset + 8u, header.width);
  writeU32Le(data, offset + 12u, header.height);
  writeU32Le(data, offset + 16u, header.pixelFormat);
  writeU32Le(data, offset + 20u, header.payloadSize);
  writeU64Le(data, offset + 24u, header.sequence);
  writeU64Le(data, offset + 32u, header.captureNs);
}

bool readBfrgHeader(const uint8_t *data, size_t size, BfrgRecordHeader &header) {
  if (data == nullptr || size < kBfrgHeaderV1Size ||
      readU32Le(data) != kBfrgMagic) {
    return false;
  }
  const uint32_t version = readU32Le(data + 4u);
  if (version != kBfrgVersion1 && version != kBfrgVersion2) {
    return false;
  }
  if (version == kBfrgVersion2 && size < kBfrgHeaderV2Size) {
    return false;
  }
  header.version = version;
  header.width = readU32Le(data + 8u);
  header.height = readU32Le(data + 12u);
  header.pixelFormat = readU32Le(data + 16u);
  header.payloadSize = readU32Le(data + 20u);
  header.sequence = readU64Le(data + 24u);
  header.captureNs = version == kBfrgVersion2 ? readU64Le(data + 32u) : 0u;
  return true;
}

}  // namespace broadify::meeting
