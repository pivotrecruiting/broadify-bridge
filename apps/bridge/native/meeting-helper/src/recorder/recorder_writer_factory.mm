#include "recorder/recorder_writer_factory.h"

#if defined(__APPLE__)
#include "recorder/recorder_encode_policy.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"

namespace broadify::meeting {

void logRecorderEvent(const char *event, const std::string &detail) {
  emitHelperEvent("{\"type\":\"meeting_recorder\",\"event\":\"" +
                  std::string(event) + "\",\"detail\":\"" + jsonEscape(detail) +
                  "\"}");
}

std::string describeRecorderError(NSError *error, const char *fallback) {
  if (error == nil) {
    return fallback;
  }
  const char *description = [[error description] UTF8String];
  return description != nullptr ? description : fallback;
}

const char *recorderFinalizeOutcomeName(RecorderFinalizeOutcome outcome) {
  switch (outcome) {
    case RecorderFinalizeOutcome::Completed:
      return "completed";
    case RecorderFinalizeOutcome::NoFrames:
      return "no_frames";
    case RecorderFinalizeOutcome::WriterFailed:
      return "writer_failed";
    case RecorderFinalizeOutcome::FinishFailed:
      return "finish_failed";
    case RecorderFinalizeOutcome::FinalizeTimeout:
      return "finalize_timeout";
    case RecorderFinalizeOutcome::RenameFailed:
      return "rename_failed";
  }
  return "unknown";
}

std::string recorderSidecarPath(const std::string &finalPath) {
  return finalPath + ".part";
}

RecorderWriterBundle makeRecorderWriter(const std::string &outputPath,
                                        uint32_t width, uint32_t height,
                                        uint32_t fps) {
  RecorderWriterBundle bundle;
  NSString *path = [NSString stringWithUTF8String:outputPath.c_str()];
  NSURL *url = [NSURL fileURLWithPath:path];

  NSError *writerError = nil;
  AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:url
                                                   fileType:AVFileTypeMPEG4
                                                      error:&writerError];
  if (writer == nil) {
    bundle.error = writerError != nil
                       ? ([[writerError localizedDescription] UTF8String]
                              ?: "writer_create_failed")
                       : "writer_create_failed";
    return bundle;
  }
  // No movieFragmentInterval: periodic fragmenting (added Jul 2026 for crash
  // safety) killed every real recording longer than ~8 s on macOS - both
  // recovered ".part" corpses died exactly at a fragment commit while the
  // same writer configuration survives isolated stress runs (see
  // meeting_recorder_writer_test). The pre-fragment configuration has hours
  // of successful field recordings; crash recovery is covered by the ".part"
  // sidecar + atomic rename instead.

  const uint32_t safeFps = fps > 0 ? fps : 30;
  const uint64_t bitrate = recorderVideoBitrateBps(width, height, safeFps);
  NSDictionary *videoSettings = @{
    AVVideoCodecKey : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(width),
    AVVideoHeightKey : @(height),
    AVVideoCompressionPropertiesKey : @{
      AVVideoAverageBitRateKey : @(bitrate),
      AVVideoExpectedSourceFrameRateKey : @(safeFps),
      AVVideoAllowFrameReorderingKey : @NO,
      AVVideoH264EntropyModeKey : AVVideoH264EntropyModeCABAC,
      AVVideoMaxKeyFrameIntervalKey : @(recorderKeyframeInterval(safeFps)),
      AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
    },
    AVVideoColorPropertiesKey : @{
      AVVideoColorPrimariesKey : AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey : AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey : AVVideoYCbCrMatrix_ITU_R_709_2,
    },
  };
  AVAssetWriterInput *videoInput =
      [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                         outputSettings:videoSettings];
  videoInput.expectsMediaDataInRealTime = YES;
  NSDictionary *pixelAttrs = @{
    (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
    (id)kCVPixelBufferWidthKey : @(width),
    (id)kCVPixelBufferHeightKey : @(height),
    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  AVAssetWriterInputPixelBufferAdaptor *adaptor =
      [AVAssetWriterInputPixelBufferAdaptor
          assetWriterInputPixelBufferAdaptorWithAssetWriterInput:videoInput
                                     sourcePixelBufferAttributes:pixelAttrs];
  if ([writer canAddInput:videoInput]) {
    [writer addInput:videoInput];
  } else {
    bundle.error = "video_input_rejected";
    return bundle;
  }

  NSDictionary *audioSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(48000),
    AVNumberOfChannelsKey : @(1),
    AVEncoderBitRateKey : @(128000),
  };
  AVAssetWriterInput *audioInput =
      [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                         outputSettings:audioSettings];
  audioInput.expectsMediaDataInRealTime = YES;
  if ([writer canAddInput:audioInput]) {
    [writer addInput:audioInput];
  } else {
    bundle.error = "audio_input_rejected";
    return bundle;
  }

  bundle.writer = writer;
  bundle.videoInput = videoInput;
  bundle.videoAdaptor = adaptor;
  bundle.audioInput = audioInput;
  return bundle;
}

RecorderFinalizeResult finalizeRecorderWriter(AVAssetWriter *writer,
                                              AVAssetWriterInput *videoInput,
                                              AVAssetWriterInput *audioInput,
                                              uint64_t videoFramesWritten,
                                              const std::string &partPath,
                                              const std::string &finalPath,
                                              int64_t finalizeTimeoutMs) {
  RecorderFinalizeResult result;
  if (writer == nil) {
    return result;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  const auto removeSidecar = [&] {
    if (!partPath.empty()) {
      [fm removeItemAtPath:[NSString stringWithUTF8String:partPath.c_str()]
                     error:nil];
    }
  };

  // A writer that already died mid-recording (disk full, I/O error, encoder
  // death; REC-02 surfaced it through recording.status at the time) cannot
  // be finished: finishWriting would only re-report the same error. Without
  // movie fragments (removed Aug 2026) the sidecar has no moov atom and is
  // unplayable, so it is removed instead of lingering as a ".part" corpse.
  if (writer.status == AVAssetWriterStatusFailed) {
    logRecorderEvent("writer_failed",
                     "at stop: " +
                         describeRecorderError(writer.error, "writer_failed") +
                         " after " + std::to_string(videoFramesWritten) +
                         " frames; sidecar removed");
    removeSidecar();
    result.outcome = RecorderFinalizeOutcome::WriterFailed;
    result.error = writer.error != nil
                       ? ([[writer.error localizedDescription] UTF8String]
                              ?: "writer_failed")
                       : "writer_failed";
    return result;
  }

  if (videoInput != nil) {
    [videoInput markAsFinished];
  }
  if (audioInput != nil) {
    [audioInput markAsFinished];
  }

  // Nothing was ever committed (stop right after start, or the camera never
  // delivered a program frame): finishing would produce a 0-byte or
  // headers-only file under the final name. Cancel instead, drop the
  // sidecar and report the machine token.
  if (videoFramesWritten == 0u) {
    if (writer.status == AVAssetWriterStatusWriting) {
      [writer cancelWriting];
    }
    removeSidecar();
    logRecorderEvent("no_frames",
                     "stopped before any video frame was committed; "
                     "sidecar removed (writer status=" +
                         std::to_string((long)writer.status) + ")");
    result.outcome = RecorderFinalizeOutcome::NoFrames;
    result.error = "no_frames";
    return result;
  }

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [writer finishWritingWithCompletionHandler:^{
    dispatch_semaphore_signal(sem);
  }];
  const long finishTimedOut = dispatch_semaphore_wait(
      sem, dispatch_time(DISPATCH_TIME_NOW,
                         finalizeTimeoutMs * (int64_t)NSEC_PER_MSEC));
  if (finishTimedOut != 0 && writer.status != AVAssetWriterStatusCompleted) {
    // Previously this fell through silently: no rename, no error - the
    // recording just vanished. Report it like any other finalize failure.
    logRecorderEvent("finalize_timeout",
                     "finishWriting exceeded " +
                         std::to_string(finalizeTimeoutMs) + "ms (status=" +
                         std::to_string((long)writer.status) + ")");
    result.outcome = RecorderFinalizeOutcome::FinalizeTimeout;
    result.error = "finalize_timeout";
    return result;
  }
  if (writer.status == AVAssetWriterStatusFailed && writer.error != nil) {
    logRecorderEvent("finish_failed",
                     describeRecorderError(writer.error, "finish_failed") +
                         " after " + std::to_string(videoFramesWritten) +
                         " frames");
    result.outcome = RecorderFinalizeOutcome::FinishFailed;
    result.error =
        [[writer.error localizedDescription] UTF8String] ?: "finish_failed";
    return result;
  }
  if (writer.status == AVAssetWriterStatusCompleted && !partPath.empty() &&
      !finalPath.empty()) {
    // REC-03: only a fully finalized file gets the real name. On failure
    // the ".part" sidecar remains and never masquerades as a finished
    // recording.
    NSString *from = [NSString stringWithUTF8String:partPath.c_str()];
    NSString *to = [NSString stringWithUTF8String:finalPath.c_str()];
    [fm removeItemAtPath:to error:nil];
    NSError *renameError = nil;
    if (![fm moveItemAtPath:from toPath:to error:&renameError]) {
      logRecorderEvent("rename_failed",
                       describeRecorderError(renameError, "rename_failed"));
      result.outcome = RecorderFinalizeOutcome::RenameFailed;
      result.error = renameError != nil
                         ? ([[renameError localizedDescription] UTF8String]
                                ?: "rename_failed")
                         : "rename_failed";
      return result;
    }
    logRecorderEvent("completed", finalPath);
  }
  return result;
}

}  // namespace broadify::meeting

#endif  // __APPLE__
