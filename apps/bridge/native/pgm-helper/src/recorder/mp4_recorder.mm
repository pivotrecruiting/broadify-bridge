#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include "recorder/mp4_recorder.h"

#include <chrono>
#include <sys/stat.h>

namespace broadify::pgm {

struct Mp4Recorder::Impl {
  mutable std::mutex mutex;
  AVAssetWriter *writer = nil;
  AVAssetWriterInput *videoInput = nil;
  AVAssetWriterInput *audioInput = nil;
  CMTime sessionStart = kCMTimeInvalid;
  bool active = false;
  bool started = false;  // startWriting + session begun
  bool withAudio = false;
  std::string filePath;
  std::string partPath;
  std::string error;
  uint64_t startedAtMs = 0;
  uint64_t appendedVideo = 0;

  void resetLocked() {
    writer = nil;
    videoInput = nil;
    audioInput = nil;
    sessionStart = kCMTimeInvalid;
    active = false;
    started = false;
    withAudio = false;
    filePath.clear();
    partPath.clear();
    appendedVideo = 0;
  }
};

Mp4Recorder::Mp4Recorder() : impl_(new Impl) {}

Mp4Recorder::~Mp4Recorder() {
  std::string ignored;
  stop(ignored);
  delete impl_;
}

bool Mp4Recorder::start(const std::string &filePath, bool withAudio, std::string &error) {
  @autoreleasepool {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->active) {
      error = "A recording is already running.";
      return false;
    }
    impl_->partPath = filePath + ".part";
    unlink(impl_->partPath.c_str());
    NSError *nsError = nil;
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:impl_->partPath.c_str()]];
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:&nsError];
    if (writer == nil) {
      error = nsError != nil ? [[nsError localizedDescription] UTF8String] : "Could not create the MP4 writer.";
      impl_->partPath.clear();
      return false;
    }
    writer.shouldOptimizeForNetworkUse = NO;
    if (withAudio) {
      NSDictionary *audioSettings = @{
        AVFormatIDKey : @(kAudioFormatMPEG4AAC),
        AVSampleRateKey : @(48000),
        AVNumberOfChannelsKey : @(2),
        AVEncoderBitRateKey : @(192000),
      };
      AVAssetWriterInput *audioInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:audioSettings];
      audioInput.expectsMediaDataInRealTime = YES;
      if ([writer canAddInput:audioInput]) {
        [writer addInput:audioInput];
        impl_->audioInput = audioInput;
      }
    }
    impl_->writer = writer;
    impl_->filePath = filePath;
    impl_->withAudio = withAudio;
    impl_->active = true;
    impl_->started = false;
    impl_->error.clear();
    impl_->appendedVideo = 0;
    impl_->startedAtMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    return true;
  }
}

void Mp4Recorder::appendVideo(CMSampleBufferRef sample, bool keyframe) {
  @autoreleasepool {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active || impl_->writer == nil || sample == nullptr) {
      return;
    }
    if (!impl_->started) {
      if (!keyframe) {
        return;  // the file must open on an IDR with its parameter sets
      }
      CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
      if (format == nullptr) {
        return;
      }
      // Passthrough: nil output settings + the encoder's format description, no second encode.
      AVAssetWriterInput *videoInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:nil sourceFormatHint:format];
      videoInput.expectsMediaDataInRealTime = YES;
      if (![impl_->writer canAddInput:videoInput]) {
        impl_->error = "video_input_rejected";
        return;
      }
      [impl_->writer addInput:videoInput];
      impl_->videoInput = videoInput;
      if (![impl_->writer startWriting]) {
        impl_->error = impl_->writer.error != nil ? [[impl_->writer.error localizedDescription] UTF8String] : "startWriting failed";
        return;
      }
      impl_->sessionStart = CMSampleBufferGetPresentationTimeStamp(sample);
      [impl_->writer startSessionAtSourceTime:impl_->sessionStart];
      impl_->started = true;
    }
    if (impl_->videoInput.isReadyForMoreMediaData) {
      if ([impl_->videoInput appendSampleBuffer:sample]) {
        impl_->appendedVideo += 1;
      } else if (impl_->writer.error != nil) {
        impl_->error = [[impl_->writer.error localizedDescription] UTF8String];
      }
    }
  }
}

void Mp4Recorder::appendAudio(CMSampleBufferRef sample) {
  @autoreleasepool {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active || !impl_->started || impl_->audioInput == nil || sample == nullptr) {
      return;
    }
    const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
    if (CMTIME_IS_VALID(pts) && CMTimeCompare(pts, impl_->sessionStart) < 0) {
      return;
    }
    if (impl_->audioInput.isReadyForMoreMediaData) {
      [impl_->audioInput appendSampleBuffer:sample];
    }
  }
}

bool Mp4Recorder::stop(std::string &error) {
  @autoreleasepool {
    AVAssetWriter *writer = nil;
    AVAssetWriterInput *videoInput = nil;
    AVAssetWriterInput *audioInput = nil;
    std::string partPath;
    std::string filePath;
    bool started = false;
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (!impl_->active) {
        return true;
      }
      writer = impl_->writer;
      videoInput = impl_->videoInput;
      audioInput = impl_->audioInput;
      partPath = impl_->partPath;
      filePath = impl_->filePath;
      started = impl_->started;
      impl_->resetLocked();
    }
    if (!started) {
      // Nothing was written (no keyframe arrived): drop the empty part file.
      unlink(partPath.c_str());
      error = "No frames were recorded.";
      return false;
    }
    [videoInput markAsFinished];
    [audioInput markAsFinished];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [writer finishWritingWithCompletionHandler:^{
      dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
      error = "finishWriting exceeded 15 s";
      return false;
    }
    if (writer.status != AVAssetWriterStatusCompleted) {
      error = writer.error != nil ? [[writer.error localizedDescription] UTF8String] : "finishWriting failed";
      return false;
    }
    if (rename(partPath.c_str(), filePath.c_str()) != 0) {
      error = "Could not rename the recording to its final name.";
      return false;
    }
    return true;
  }
}

bool Mp4Recorder::isActive() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->active;
}

RecordingStatus Mp4Recorder::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  RecordingStatus s;
  s.active = impl_->active;
  s.filePath = impl_->filePath;
  s.startedAtMs = impl_->startedAtMs;
  s.error = impl_->error;
  if (impl_->active && !impl_->partPath.empty()) {
    struct stat st {};
    if (stat(impl_->partPath.c_str(), &st) == 0) {
      s.bytes = static_cast<uint64_t>(st.st_size);
    }
  }
  return s;
}

}  // namespace broadify::pgm
