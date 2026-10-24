#pragma once

#include "audio/audio_source.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace broadify::pgm {

struct EncodedAudioPacket {
  std::vector<uint8_t> opus;
  uint64_t captureNs = 0;  // capture time of the first sample in the packet
  uint32_t frames = 960;   // 20 ms at 48 kHz
};

/** Opus 48 kHz stereo, 20 ms frames, ~96 kbps, low delay. Buffers PCM until a full frame is available. */
class OpusAudioEncoder {
 public:
  OpusAudioEncoder();
  ~OpusAudioEncoder();
  OpusAudioEncoder(const OpusAudioEncoder &) = delete;
  OpusAudioEncoder &operator=(const OpusAudioEncoder &) = delete;

  bool ready() const { return encoder_ != nullptr; }
  void push(const AudioChunk &chunk);
  std::function<void(EncodedAudioPacket &&)> onPacket;

 private:
  void *encoder_ = nullptr;  // OpusEncoder*
  std::vector<float> pending_;
  uint64_t pendingStartNs_ = 0;
};

}  // namespace broadify::pgm
