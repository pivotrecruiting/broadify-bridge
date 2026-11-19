#pragma once

#include "audio/audio_source.h"
#include "common/live_types.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace broadify::pgm {

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
