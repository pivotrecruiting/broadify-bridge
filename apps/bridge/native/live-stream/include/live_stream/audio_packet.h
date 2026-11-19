#pragma once

#include <cstdint>
#include <vector>

namespace broadify::live {

/** One encoded Opus packet (20 ms at 48 kHz) as the publisher sends it. */
struct EncodedAudioPacket {
  std::vector<uint8_t> opus;
  uint64_t captureNs = 0;  // capture time of the first sample in the packet
  uint32_t frames = 960;   // 20 ms at 48 kHz
};

}  // namespace broadify::live
