#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace broadify::pgm {

/** Interleaved float32 PCM, 48 kHz, 2 channels. */
struct AudioChunk {
  const float *samples = nullptr;
  uint32_t frames = 0;  // frames per channel
  uint64_t captureNs = 0;
};

using AudioSink = std::function<void(const AudioChunk &chunk)>;

class AudioSource {
 public:
  virtual ~AudioSource() = default;
  virtual bool start(AudioSink sink, std::string &errorCode, std::string &error) = 0;
  virtual void stop() = 0;
};

#if defined(__APPLE__)
/**
 * Opens the audio device that belongs to a UVC video device (same model name,
 * e.g. "ATEM Mini", "RØDECaster Video") and delivers 48 kHz stereo float.
 * Returns nullptr when no matching audio device exists (video-only preview).
 */
std::unique_ptr<AudioSource> createPairedAudioSource(const std::string &videoDisplayName);
#endif

}  // namespace broadify::pgm
