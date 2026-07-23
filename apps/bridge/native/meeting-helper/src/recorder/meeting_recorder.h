#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

// A selectable audio input device (microphone).
struct MicrophoneInfo {
  std::string deviceId;  // AVCaptureDevice uniqueID
  std::string label;     // human-readable name
  bool isDefault = false;
};

struct RecordingStatus {
  bool active = false;
  std::string filePath;
  double elapsedSeconds = 0.0;
  uint64_t videoFrames = 0;
  std::string lastError;
};

// Records the composited program video plus a chosen microphone to an .mp4
// (H.264 video + AAC audio) using AVAssetWriter. Video frames are pushed in
// from the frame pipeline; audio is captured from an internal AVCaptureSession
// on the selected device. Video and audio are timestamped on the shared macOS
// host clock so they stay in sync. All public methods are thread-safe:
// start/stop are driven from the control thread, appendVideoFrame from the
// pipeline thread.
class MeetingRecorder {
 public:
  MeetingRecorder();
  ~MeetingRecorder();

  MeetingRecorder(const MeetingRecorder &) = delete;
  MeetingRecorder &operator=(const MeetingRecorder &) = delete;

  // Enumerate available microphone input devices (best-effort; empty on error
  // or on platforms without capture support).
  std::vector<MicrophoneInfo> listMicrophones() const;

  // Begin recording program frames of the given geometry plus the microphone
  // identified by micDeviceId (empty = system default input) to filePath.
  // Returns false and sets the status error on failure (already recording,
  // permission denied, unwritable path, ...).
  bool start(const std::string &filePath, const std::string &micDeviceId,
             uint32_t width, uint32_t height, uint32_t fps);

  // Append one composited program frame (RGBA8, width*height*4 bytes). No-op if
  // not recording or on a geometry mismatch. Safe to call from the pipeline.
  void appendVideoFrame(const uint8_t *rgba, uint32_t width, uint32_t height);

  // Finalize and close the current recording. Blocks until the file is written.
  // No-op if not recording.
  void stop();

  RecordingStatus status() const;

  // Opaque implementation type. Declared public (but left undefined here) so the
  // macOS AVFoundation capture delegate can name it; the pointer stays private.
  struct Impl;

 private:
  Impl *impl_;
};

}  // namespace broadify::meeting
