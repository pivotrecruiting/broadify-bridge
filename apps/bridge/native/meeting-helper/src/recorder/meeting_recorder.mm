#include "recorder/meeting_recorder.h"

#include <chrono>
#include <mutex>

#if defined(__APPLE__)
#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#endif

namespace broadify::meeting {

#if defined(__APPLE__)

namespace {

double secondsSince(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - start)
      .count();
}

// Blocks briefly to resolve microphone authorization. Returns true only when
// access is granted.
bool ensureMicrophoneAccess() {
  const AVAuthorizationStatus status =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (status == AVAuthorizationStatusAuthorized) {
    return true;
  }
  if (status != AVAuthorizationStatusNotDetermined) {
    return false;  // denied or restricted
  }
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block bool granted = false;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL ok) {
                             granted = ok;
                             dispatch_semaphore_signal(sem);
                           }];
  // Bounded wait so we never hang the control thread on a stuck prompt.
  dispatch_semaphore_wait(
      sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)));
  return granted;
}

AVCaptureDevice *resolveMicrophone(const std::string &deviceId) {
  if (deviceId.empty()) {
    return [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
  }
  NSString *target = [NSString stringWithUTF8String:deviceId.c_str()];
  AVCaptureDeviceDiscoverySession *session = [AVCaptureDeviceDiscoverySession
      discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInMicrophone,
                                         AVCaptureDeviceTypeExternalUnknown ]
                            mediaType:AVMediaTypeAudio
                             position:AVCaptureDevicePositionUnspecified];
  for (AVCaptureDevice *device in session.devices) {
    if ([[device uniqueID] isEqualToString:target]) {
      return device;
    }
  }
  return [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
}

}  // namespace

struct MeetingRecorder::Impl {
  mutable std::mutex mutex;

  bool active = false;
  std::string filePath;
  std::string lastError;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 30;
  uint64_t videoFrames = 0;
  std::chrono::steady_clock::time_point startedAt;

  AVAssetWriter *writer = nil;
  AVAssetWriterInput *videoInput = nil;
  AVAssetWriterInputPixelBufferAdaptor *videoAdaptor = nil;
  AVAssetWriterInput *audioInput = nil;
  CMTime sessionStart = kCMTimeInvalid;

  AVCaptureSession *micSession = nil;
  AVCaptureAudioDataOutput *audioOutput = nil;
  id delegate = nil;               // BroadifyRecorderAudioDelegate
  dispatch_queue_t audioQueue = nil;

  void teardownLocked() {
    writer = nil;
    videoInput = nil;
    videoAdaptor = nil;
    audioInput = nil;
    micSession = nil;
    audioOutput = nil;
    delegate = nil;
    audioQueue = nil;
    sessionStart = kCMTimeInvalid;
  }
};

}  // namespace broadify::meeting

// Forwards captured microphone sample buffers into the recorder's audio input.
@interface BroadifyRecorderAudioDelegate
    : NSObject <AVCaptureAudioDataOutputSampleBufferDelegate>
@property(nonatomic, assign) broadify::meeting::MeetingRecorder::Impl *owner;
@end

@implementation BroadifyRecorderAudioDelegate
- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  broadify::meeting::MeetingRecorder::Impl *owner = self.owner;
  if (owner == nullptr) {
    return;
  }
  std::lock_guard<std::mutex> lock(owner->mutex);
  if (!owner->active || owner->audioInput == nil ||
      !CMTIME_IS_VALID(owner->sessionStart)) {
    return;
  }
  if (!owner->audioInput.isReadyForMoreMediaData) {
    return;  // encoder busy; drop rather than block the capture queue
  }
  const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (CMTIME_IS_VALID(pts) &&
      CMTimeCompare(pts, owner->sessionStart) < 0) {
    return;  // captured before the writing session started
  }
  [owner->audioInput appendSampleBuffer:sampleBuffer];
}
@end

namespace broadify::meeting {

MeetingRecorder::MeetingRecorder() : impl_(new Impl()) {}

MeetingRecorder::~MeetingRecorder() {
  stop();
  delete impl_;
}

std::vector<MicrophoneInfo> MeetingRecorder::listMicrophones() const {
  std::vector<MicrophoneInfo> result;
  @autoreleasepool {
    AVCaptureDevice *defaultDevice =
        [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    NSString *defaultId = [defaultDevice uniqueID];
    AVCaptureDeviceDiscoverySession *session = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
          AVCaptureDeviceTypeBuiltInMicrophone,
          AVCaptureDeviceTypeExternalUnknown
        ]
                              mediaType:AVMediaTypeAudio
                               position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *device in session.devices) {
      MicrophoneInfo info;
      info.deviceId = [[device uniqueID] UTF8String] ?: "";
      info.label = [[device localizedName] UTF8String] ?: info.deviceId;
      info.isDefault =
          defaultId != nil && [[device uniqueID] isEqualToString:defaultId];
      result.push_back(std::move(info));
    }
  }
  return result;
}

bool MeetingRecorder::start(const std::string &filePath,
                            const std::string &micDeviceId, uint32_t width,
                            uint32_t height, uint32_t fps) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->active) {
    impl_->lastError = "already_recording";
    return false;
  }
  if (width == 0 || height == 0 || filePath.empty()) {
    impl_->lastError = "invalid_arguments";
    return false;
  }

  @autoreleasepool {
    if (!ensureMicrophoneAccess()) {
      impl_->lastError = "microphone_permission_denied";
      return false;
    }

    NSString *path = [NSString stringWithUTF8String:filePath.c_str()];
    NSURL *url = [NSURL fileURLWithPath:path];
    NSFileManager *fm = [NSFileManager defaultManager];
    if ([fm fileExistsAtPath:path]) {
      [fm removeItemAtPath:path error:nil];
    }

    NSError *writerError = nil;
    AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:url
                                                     fileType:AVFileTypeMPEG4
                                                        error:&writerError];
    if (writer == nil) {
      impl_->lastError = writerError != nil
                             ? [[writerError localizedDescription] UTF8String]
                             : "writer_create_failed";
      return false;
    }

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
      impl_->lastError = "video_input_rejected";
      return false;
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
      impl_->lastError = "audio_input_rejected";
      return false;
    }

    // Microphone capture session.
    AVCaptureDevice *micDevice = resolveMicrophone(micDeviceId);
    if (micDevice == nil) {
      impl_->lastError = "microphone_not_found";
      return false;
    }
    NSError *micError = nil;
    AVCaptureDeviceInput *micInput =
        [AVCaptureDeviceInput deviceInputWithDevice:micDevice error:&micError];
    if (micInput == nil) {
      impl_->lastError = micError != nil
                             ? [[micError localizedDescription] UTF8String]
                             : "microphone_input_failed";
      return false;
    }
    AVCaptureSession *micSession = [[AVCaptureSession alloc] init];
    if (![micSession canAddInput:micInput]) {
      impl_->lastError = "microphone_input_rejected";
      return false;
    }
    [micSession addInput:micInput];
    AVCaptureAudioDataOutput *audioOutput =
        [[AVCaptureAudioDataOutput alloc] init];
    if (![micSession canAddOutput:audioOutput]) {
      impl_->lastError = "microphone_output_rejected";
      return false;
    }
    [micSession addOutput:audioOutput];

    if (![writer startWriting]) {
      impl_->lastError = writer.error != nil
                             ? [[writer.error localizedDescription] UTF8String]
                             : "start_writing_failed";
      return false;
    }
    const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
    [writer startSessionAtSourceTime:sessionStart];

    BroadifyRecorderAudioDelegate *delegate =
        [[BroadifyRecorderAudioDelegate alloc] init];
    delegate.owner = impl_;
    dispatch_queue_t audioQueue = dispatch_queue_create(
        "com.broadify.meeting.recorder.audio", DISPATCH_QUEUE_SERIAL);
    [audioOutput setSampleBufferDelegate:delegate queue:audioQueue];
    [micSession startRunning];

    impl_->writer = writer;
    impl_->videoInput = videoInput;
    impl_->videoAdaptor = adaptor;
    impl_->audioInput = audioInput;
    impl_->sessionStart = sessionStart;
    impl_->micSession = micSession;
    impl_->audioOutput = audioOutput;
    impl_->delegate = delegate;
    impl_->audioQueue = audioQueue;
    impl_->filePath = filePath;
    impl_->width = width;
    impl_->height = height;
    impl_->fps = safeFps;
    impl_->videoFrames = 0;
    impl_->startedAt = std::chrono::steady_clock::now();
    impl_->lastError.clear();
    impl_->active = true;
  }
  return true;
}

void MeetingRecorder::appendVideoFrame(const uint8_t *rgba, uint32_t width,
                                       uint32_t height) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->active || rgba == nullptr) {
    return;
  }
  if (width != impl_->width || height != impl_->height) {
    return;  // geometry changed mid-recording; skip until it matches
  }
  if (impl_->videoInput == nil || !impl_->videoInput.isReadyForMoreMediaData) {
    return;  // encoder busy; drop this frame
  }
  CVPixelBufferPoolRef pool = impl_->videoAdaptor.pixelBufferPool;
  if (pool == nullptr) {
    return;
  }
  @autoreleasepool {
    CVPixelBufferRef pixelBuffer = nullptr;
    if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool,
                                           &pixelBuffer) != kCVReturnSuccess ||
        pixelBuffer == nullptr) {
      return;
    }
    CVPixelBufferLockBaseAddress(pixelBuffer, 0);
    uint8_t *dst =
        static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
    const size_t dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
    // RGBA8 -> BGRA8 (swap R and B) honouring the pixel buffer's row padding.
    vImage_Buffer src{const_cast<uint8_t *>(rgba), height, width,
                      static_cast<size_t>(width) * 4u};
    vImage_Buffer out{dst, height, width, dstStride};
    const uint8_t permuteMap[4] = {2, 1, 0, 3};
    vImagePermuteChannels_ARGB8888(&src, &out, permuteMap, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);

    const CMTime presentationTime = CMClockGetTime(CMClockGetHostTimeClock());
    if ([impl_->videoAdaptor appendPixelBuffer:pixelBuffer
                          withPresentationTime:presentationTime]) {
      ++impl_->videoFrames;
    }
    CVPixelBufferRelease(pixelBuffer);
  }
}

void MeetingRecorder::stop() {
  // Detach the capture pipeline first (outside the lock) so an in-flight audio
  // callback can finish and no new samples arrive, then finalize the file.
  AVCaptureSession *micSession = nil;
  AVCaptureAudioDataOutput *audioOutput = nil;
  AVAssetWriter *writer = nil;
  AVAssetWriterInput *videoInput = nil;
  AVAssetWriterInput *audioInput = nil;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active) {
      return;
    }
    impl_->active = false;
    micSession = impl_->micSession;
    audioOutput = impl_->audioOutput;
    writer = impl_->writer;
    videoInput = impl_->videoInput;
    audioInput = impl_->audioInput;
  }

  @autoreleasepool {
    if (audioOutput != nil) {
      [audioOutput setSampleBufferDelegate:nil queue:nil];
    }
    if (micSession != nil) {
      [micSession stopRunning];
    }
    if (videoInput != nil) {
      [videoInput markAsFinished];
    }
    if (audioInput != nil) {
      [audioInput markAsFinished];
    }
    if (writer != nil) {
      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      [writer finishWritingWithCompletionHandler:^{
        dispatch_semaphore_signal(sem);
      }];
      dispatch_semaphore_wait(
          sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)));
      if (writer.status == AVAssetWriterStatusFailed && writer.error != nil) {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        impl_->lastError = [[writer.error localizedDescription] UTF8String]
                               ?: "finish_failed";
      }
    }
  }

  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->teardownLocked();
}

RecordingStatus MeetingRecorder::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  RecordingStatus status;
  status.active = impl_->active;
  status.filePath = impl_->filePath;
  status.videoFrames = impl_->videoFrames;
  status.elapsedSeconds = impl_->active ? secondsSince(impl_->startedAt) : 0.0;
  status.lastError = impl_->lastError;
  return status;
}

#endif  // __APPLE__

}  // namespace broadify::meeting
