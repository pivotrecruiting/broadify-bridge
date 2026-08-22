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

  std::vector<uint8_t> keepAlive(kBfrgHeaderV2Size);
  BfrgRecordHeader heartbeat;
  heartbeat.payloadSize = 0u;
  heartbeat.sequence = 1ull << 63;
  heartbeat.captureNs = 987654321u;
  writeBfrgHeaderV2(keepAlive, 0, heartbeat);
  ok &= expect(readBfrgHeader(keepAlive.data(), keepAlive.size(), parsed),
               "v2 zero-payload keep-alive parses");
  ok &= expect(parsed.version == kBfrgVersion2, "keep-alive is v2");
  ok &= expect(parsed.width == 0 && parsed.height == 0,
               "keep-alive carries no display geometry");
  ok &= expect(parsed.payloadSize == 0u, "keep-alive has no payload");
  ok &= expect(parsed.captureNs == heartbeat.captureNs,
               "keep-alive keeps capture_ns");
  return ok ? 0 : 1;
}
