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
// type, fragmenting, bitrate, input settings) is exercisable by ctest without
// microphone access.
RecorderWriterBundle makeRecorderWriter(const std::string &outputPath,
                                        uint32_t width, uint32_t height,
                                        uint32_t fps);

}  // namespace broadify::meeting

#endif  // __APPLE__
