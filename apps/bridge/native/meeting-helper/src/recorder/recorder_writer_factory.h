#pragma once

#if defined(__APPLE__)

#import <AVFoundation/AVFoundation.h>

#include <cstdint>
#include <string>

namespace broadify::meeting {

// The AVAssetWriter pipeline the meeting recorder writes with. Built by
// makeRecorderWriter; `writer == nil` signals failure with `error` set to a
// machine token or the underlying NSError description.
struct RecorderWriterBundle {
  AVAssetWriter *writer = nil;
  AVAssetWriterInput *videoInput = nil;
  AVAssetWriterInputPixelBufferAdaptor *videoAdaptor = nil;
  AVAssetWriterInput *audioInput = nil;
  std::string error;
};

// Sidecar path the recorder writes to until finishWriting succeeds (REC-03):
// the final path never names a half-written file.
std::string recorderSidecarPath(const std::string &finalPath);

// Builds the H.264+AAC writer pipeline for the given output file. Extracted
// from MeetingRecorder::start so the exact production configuration (file
// type, fragmenting, bitrate, color tags, input settings) is exercisable by
// ctest without microphone access.
RecorderWriterBundle makeRecorderWriter(const std::string &outputPath,
                                        uint32_t width, uint32_t height,
                                        uint32_t fps);

// Outcome of finalizeRecorderWriter. The machine token in
// RecorderFinalizeResult::error is what recording.status.last_error carries.
enum class RecorderFinalizeOutcome {
  Completed,        // file finalized and renamed to the final path
  NoFrames,         // no video sample was ever committed: cancelled, sidecar removed
  WriterFailed,     // the writer had already failed before stop: sidecar removed
  FinishFailed,     // finishWriting reported Failed: sidecar kept
  FinalizeTimeout,  // finishWriting exceeded the timeout: sidecar kept
  RenameFailed,     // finalized but the rename to the final path failed
};

struct RecorderFinalizeResult {
  RecorderFinalizeOutcome outcome = RecorderFinalizeOutcome::Completed;
  // Empty on Completed, otherwise the machine token ("no_frames",
  // "finalize_timeout") or the NSError localizedDescription.
  std::string error;
};

const char *recorderFinalizeOutcomeName(RecorderFinalizeOutcome outcome);

// Finishes (or cancels) a writer that was started with startWriting and
// moves the sidecar to its final name. Extracted from MeetingRecorder::stop
// so ctest can drive the zero-frame and failure paths without a microphone.
// Emits the "meeting_recorder" events (completed, no_frames, writer_failed,
// finish_failed, finalize_timeout, rename_failed) itself.
RecorderFinalizeResult finalizeRecorderWriter(AVAssetWriter *writer,
                                              AVAssetWriterInput *videoInput,
                                              AVAssetWriterInput *audioInput,
                                              uint64_t videoFramesWritten,
                                              const std::string &partPath,
                                              const std::string &finalPath,
                                              int64_t finalizeTimeoutMs);

// One JSON line per recorder incident, so a writer death is pinpointed the
// moment it happens instead of surfacing minutes later as an opaque status
// string at stop. Goes through the helper event log (stdout + sidecar file -
// stdout alone is invisible on macOS, where the bridge launches via `open`).
void logRecorderEvent(const char *event, const std::string &detail);

// Full NSError description (domain, code, userInfo with any underlying error)
// for the log; localizedDescription alone collapses to phrases like "The
// operation could not be completed".
std::string describeRecorderError(NSError *error, const char *fallback);

}  // namespace broadify::meeting

#endif  // __APPLE__
