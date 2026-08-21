#include "preview/raw_frame_record.h"

#include <iostream>
#include <vector>

using namespace broadify::meeting;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "raw_frame_record_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  BfrgRecordHeader header;
  header.width = 1920;
  header.height = 1080;
  header.payloadSize = 1920u * 1080u * 4u;
  header.sequence = 42;
  header.captureNs = 123456789;
  std::vector<uint8_t> bytes(kBfrgHeaderV2Size);
  writeBfrgHeaderV2(bytes, 0, header);

  BfrgRecordHeader parsed;
  bool ok = true;
  ok &= expect(readBfrgHeader(bytes.data(), bytes.size(), parsed), "v2 parses");
  ok &= expect(parsed.version == kBfrgVersion2, "v2 version");
  ok &= expect(parsed.captureNs == header.captureNs, "v2 capture_ns");

  bytes[4] = static_cast<uint8_t>(kBfrgVersion1);
  ok &= expect(readBfrgHeader(bytes.data(), kBfrgHeaderV1Size, parsed), "v1 parses");
  ok &= expect(parsed.version == kBfrgVersion1, "v1 version");
  ok &= expect(parsed.captureNs == 0, "v1 capture_ns defaults");
  return ok ? 0 : 1;
}
