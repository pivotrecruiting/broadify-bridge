#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#if defined(__APPLE__)
#include <CoreMedia/CoreMedia.h>
#endif

namespace broadify::pgm {

/** Interleaved float32 PCM, 48 kHz, 2 channels. */
struct AudioChunk {
  const float *samples = nullptr;
  uint32_t frames = 0;  // frames per channel
  uint64_t captureNs = 0;
#if defined(__APPLE__)
  /** Original capture sample buffer (valid for the callback's duration; AAC recording appends it). */
  CMSampleBufferRef sample = nullptr;
#endif
};

using AudioSink = std::function<void(const AudioChunk &chunk)>;

class AudioSource {
 public:
  virtual ~AudioSource() = default;
  virtual bool start(AudioSink sink, std::string &errorCode, std::string &error) = 0;
  /** Ends delivery. A backend may wait here for a sink call in flight: never call it under a lock the sink takes. */
  virtual void stop() = 0;
};

/**
 * Opens the audio device that belongs to a UVC video device (same model name,
 * e.g. "ATEM Mini", "RØDECaster Video"; on Windows first the same physical
 * device, found through the video device's backend id) and delivers 48 kHz
 * stereo float. Returns nullptr when no matching audio device exists
 * (video-only preview). Implemented once per platform (macOS:
 * audio_capture_avfoundation.mm, Windows: audio_capture_wasapi.cpp).
 */
std::unique_ptr<AudioSource> createPairedAudioSource(const std::string &videoDisplayName, const std::string &videoDeviceId);

}  // namespace broadify::pgm
