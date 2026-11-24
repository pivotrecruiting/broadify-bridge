#pragma once

#include "recorder/recording_codec.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace broadify::meeting {

// A selectable audio input device (microphone).
struct MicrophoneInfo {
  std::string deviceId;  // AVCaptureDevice uniqueID
  std::string label;     // human-readable name
  bool isDefault = false;
};

// One recording to start. A struct so that a further output of the same
// recording becomes a field here instead of another start() signature.
struct RecordingRequest {
  // Final path of the file; its extension is the container of `codec`.
  std::string filePath;
  // Microphone to record (empty = system default input).
  std::string micDeviceId;
  // Program geometry the frames arrive in.
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 0;
  RecordingCodec codec = RecordingCodec::H264;
};

// start() failure tokens with a meaning beyond the message. They reach the
// bridge as the message of `recording_start_failed` and become the errorCode
// of the relay command (RECORDING_ERROR_TOKENS, meeting-command-handler.ts).
//
// The platform recorder cannot write the codec, or the machine has no
// hardware encoder for it (hardware only, no software fallback: ADR-0010).
inline constexpr char kRecordingCodecUnsupportedError[] =
    "meeting_recording_codec_unsupported";
// The target volume has less free space than recorderMinFreeDiskBytes;
// RecordingStatus::diskSpaceLow carries the numbers.
inline constexpr char kRecordingDiskSpaceLowError[] = "recording_disk_space_low";

struct RecordingDiskSpace {
  uint64_t requiredBytes = 0;
  uint64_t freeBytes = 0;
};

struct RecordingStatus {
  bool active = false;
  std::string filePath;
  // Codec of the current or last recording; empty before the first start.
  std::optional<RecordingCodec> codec;
  double elapsedSeconds = 0.0;
  uint64_t videoFrames = 0;
  // Program frames the recorder could not encode (encoder backpressure, and
  // on macOS frames the recorder mailbox replaced because the worker thread
  // fell behind) and frames waiting in that mailbox right now.
  uint64_t droppedFrames = 0;
  uint64_t queuedFrames = 0;
  std::string lastError;
  // Set while lastError is kRecordingDiskSpaceLowError: what the refused
  // start needed and what the volume had.
  std::optional<RecordingDiskSpace> diskSpaceLow;
  // Microphone sample counters (RecorderAudioRebase): samples handed to the
  // writer at/after the session start vs. samples dropped because they were
  // captured before it. Optional and additive: filled by the Windows recorder,
  // absent (serialized as null) on macOS and the stub.
  std::optional<uint64_t> audioSamplesWritten;
  std::optional<uint64_t> audioSamplesDroppedBeforeStart;
};

// Records the composited program video plus a chosen microphone in the
// requested codec (kRecordingCodecFormats: H.264/HEVC + AAC in .mp4, ProRes +
// PCM in .mov) using AVAssetWriter. Video frames are pushed in
// from the frame pipeline; audio is captured from an internal AVCaptureSession
// on the selected device. Video and audio are timestamped on the shared macOS
// host clock so they stay in sync. All public methods are thread-safe:
// start/stop are driven from the control thread, appendVideoFrame from the
// pipeline thread. On macOS appendVideoFrame only copies the frame into a
// mailbox (RecorderVideoWorker); swizzle, CFR planning and the writer append
// run on the recorder's own thread so the program tick never waits on the
// encoder.
class MeetingRecorder {
 public:
  MeetingRecorder();
  ~MeetingRecorder();

  MeetingRecorder(const MeetingRecorder &) = delete;
  MeetingRecorder &operator=(const MeetingRecorder &) = delete;

  // Enumerate available microphone input devices (best-effort; empty on error
  // or on platforms without capture support).
  std::vector<MicrophoneInfo> listMicrophones() const;

  // Begin recording program frames plus the requested microphone. Returns
  // false and sets the status error on failure (already recording,
  // permission denied, unwritable path, unsupported codec, ...).
  bool start(const RecordingRequest &request);

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
