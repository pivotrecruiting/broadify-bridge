#pragma once

#include <cstdint>
#include <mutex>
#include <string>

#if defined(__APPLE__)
#include <CoreMedia/CoreMedia.h>
#endif

namespace broadify::pgm {

struct RecordingStatus {
  bool active = false;
  std::string filePath;
  uint64_t startedAtMs = 0;
  uint64_t bytes = 0;
  std::string error;
};

/**
 * Records the program as MP4 without re-encoding: the hardware encoder's
 * H.264 samples are written through (passthrough input with the encoder's
 * format description), audio goes in as AAC from the captured PCM sample
 * buffers. The session starts at the first keyframe; audio before that is
 * dropped. Writes <path>.part and renames on a clean stop.
 */
class Mp4Recorder {
 public:
  Mp4Recorder();
  ~Mp4Recorder();
  Mp4Recorder(const Mp4Recorder &) = delete;
  Mp4Recorder &operator=(const Mp4Recorder &) = delete;

  bool start(const std::string &filePath, bool withAudio, std::string &error);
  bool stop(std::string &error);
  bool isActive() const;
  RecordingStatus status() const;

#if defined(__APPLE__)
  void appendVideo(CMSampleBufferRef encodedSample, bool keyframe);
  void appendAudio(CMSampleBufferRef pcmSample);
#endif

 private:
  struct Impl;
  Impl *impl_;
};

}  // namespace broadify::pgm
