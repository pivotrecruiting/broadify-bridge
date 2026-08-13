#include "recorder/recorder_writer_factory.h"

#if defined(__APPLE__)

namespace broadify::meeting {

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

  // ~0.2 bits/pixel is visually clean for screen+camera content; cap so 4K
  // never balloons.
  const uint64_t pixels = static_cast<uint64_t>(width) * height;
  const uint32_t safeFps = fps > 0 ? fps : 30;
  uint64_t bitrate = pixels * safeFps / 5;  // 0.2 bpp
  if (bitrate > 24000000ull) {
    bitrate = 24000000ull;
  }
  if (bitrate < 2000000ull) {
    bitrate = 2000000ull;
  }
  NSDictionary *videoSettings = @{
    AVVideoCodecKey : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(width),
    AVVideoHeightKey : @(height),
    AVVideoCompressionPropertiesKey : @{
      AVVideoAverageBitRateKey : @(bitrate),
      AVVideoMaxKeyFrameIntervalKey : @(safeFps * 2),
      AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
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

}  // namespace broadify::meeting

#endif  // __APPLE__
