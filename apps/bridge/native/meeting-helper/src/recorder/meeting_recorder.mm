#include "recorder/meeting_recorder.h"

#if defined(__APPLE__)
#include "recorder/recorder_writer_factory.h"
#include "util/json_utils.h"
#endif

#include <chrono>
#include <iostream>
#include <mutex>

#if defined(__APPLE__)
#include <sys/statvfs.h>

#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#endif

namespace broadify::meeting {

#if defined(__APPLE__)

namespace {

// Minimum free disk space to start a recording (REC-02): well above what a
// few minutes of 1080p H.264 needs, far below any realistic working drive.
constexpr uint64_t kMinFreeDiskBytes = 500ull * 1024ull * 1024ull;

double secondsSince(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - start)
      .count();
}

// One JSON line per recorder incident on stdout - the bridge forwards
// "meeting_recorder" events into its process log, so a writer death is
// pinpointed the moment it happens instead of surfacing minutes later as an
// opaque status string at stop.
void logRecorderEvent(const char *event, const std::string &detail) {
  std::cout << "{\"type\":\"meeting_recorder\",\"event\":\"" << event
            << "\",\"detail\":\"" << jsonEscape(detail) << "\"}" << std::endl;
}

// Full NSError description (domain, code, userInfo with any underlying error)
// for the log; localizedDescription alone collapses to phrases like "The
// operation could not be completed".
std::string describeError(NSError *error, const char *fallback) {
  if (error == nil) {
    return fallback;
  }
  const char *description = [[error description] UTF8String];
  return description != nullptr ? description : fallback;
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
  // True while start() builds the pipeline OUTSIDE the lock (K-04): guards
  // against a second concurrent start without serializing the hot path.
  bool starting = false;
  std::string filePath;
  // The writer targets filePath + ".part" until finishWriting succeeds
  // (REC-03): the final path never names a half-written file, and an existing
  // recording is never deleted before the new one is complete.
  std::string partPath;
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
    partPath.clear();
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
  // K-04: setup runs WITHOUT the mutex. appendVideoFrame is called from the
  // program loop every tick on this same mutex - holding it across the
  // microphone permission wait (up to 10 s) froze VCam/FrameBus/SDI/preview
  // for the whole init. The lock is only taken to claim the start and to
  // publish the finished pipeline.
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->active || impl_->starting) {
      impl_->lastError = "already_recording";
      return false;
    }
    if (width == 0 || height == 0 || filePath.empty()) {
      impl_->lastError = "invalid_arguments";
      return false;
    }
    impl_->starting = true;
  }
  const auto fail = [this](const std::string &error) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->lastError = error;
    impl_->starting = false;
    return false;
  };

  @autoreleasepool {
    if (!ensureMicrophoneAccess()) {
      return fail("microphone_permission_denied");
    }

    // REC-02: refuse to start on a nearly full disk instead of failing
    // opaquely minutes into the recording.
    const std::string directory = [&] {
      const size_t slash = filePath.find_last_of('/');
      return slash == std::string::npos ? std::string(".")
                                        : filePath.substr(0, slash);
    }();
    struct statvfs vfs {};
    if (statvfs(directory.c_str(), &vfs) == 0) {
      const uint64_t freeBytes =
          static_cast<uint64_t>(vfs.f_bavail) * vfs.f_frsize;
      if (freeBytes < kMinFreeDiskBytes) {
        return fail("disk_full");
      }
    }

    // REC-03: record into a sidecar and only rename to the final path after a
    // successful finish. The old code deleted the target up front, so a crash
    // left neither the old nor a playable new file.
    const std::string partPathUtf8 = recorderSidecarPath(filePath);
    NSString *partPath = [NSString stringWithUTF8String:partPathUtf8.c_str()];
    NSFileManager *fm = [NSFileManager defaultManager];
    if ([fm fileExistsAtPath:partPath]) {
      [fm removeItemAtPath:partPath error:nil];
    }

    RecorderWriterBundle bundle =
        makeRecorderWriter(partPathUtf8, width, height, fps);
    if (bundle.writer == nil) {
      return fail(bundle.error);
    }
    AVAssetWriter *writer = bundle.writer;
    AVAssetWriterInput *videoInput = bundle.videoInput;
    AVAssetWriterInputPixelBufferAdaptor *adaptor = bundle.videoAdaptor;
    AVAssetWriterInput *audioInput = bundle.audioInput;
    const uint32_t safeFps = fps > 0 ? fps : 30;

    // Microphone capture session.
    AVCaptureDevice *micDevice = resolveMicrophone(micDeviceId);
    if (micDevice == nil) {
      return fail("microphone_not_found");
    }
    NSError *micError = nil;
    AVCaptureDeviceInput *micInput =
        [AVCaptureDeviceInput deviceInputWithDevice:micDevice error:&micError];
    if (micInput == nil) {
      return fail(micError != nil
                      ? [[micError localizedDescription] UTF8String]
                      : "microphone_input_failed");
    }
    AVCaptureSession *micSession = [[AVCaptureSession alloc] init];
    if (![micSession canAddInput:micInput]) {
      return fail("microphone_input_rejected");
    }
    [micSession addInput:micInput];
    AVCaptureAudioDataOutput *audioOutput =
        [[AVCaptureAudioDataOutput alloc] init];
    if (![micSession canAddOutput:audioOutput]) {
      return fail("microphone_output_rejected");
    }
    [micSession addOutput:audioOutput];

    if (![writer startWriting]) {
      return fail(writer.error != nil
                      ? [[writer.error localizedDescription] UTF8String]
                      : "start_writing_failed");
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

    // Publish the finished pipeline under a short lock (K-04).
    std::lock_guard<std::mutex> lock(impl_->mutex);
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
    impl_->partPath = partPathUtf8;
    impl_->width = width;
    impl_->height = height;
    impl_->fps = safeFps;
    impl_->videoFrames = 0;
    impl_->startedAt = std::chrono::steady_clock::now();
    impl_->lastError.clear();
    impl_->starting = false;
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
    } else if (impl_->writer.status == AVAssetWriterStatusFailed &&
               impl_->lastError.empty()) {
      // REC-02: a failed writer (disk full, I/O error) used to be silently
      // ignored - the recording looked healthy while writing nothing. Surface
      // it once via recording.status (which streams to the webapp).
      impl_->lastError = impl_->writer.error != nil
                             ? ([[impl_->writer.error localizedDescription]
                                    UTF8String]
                                    ?: "writer_failed")
                             : "writer_failed";
      logRecorderEvent(
          "writer_failed",
          describeError(impl_->writer.error, "writer_failed") +
              " after " + std::to_string(impl_->videoFrames) + " frames");
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
  std::string finalPath;
  std::string partPath;
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
    finalPath = impl_->filePath;
    partPath = impl_->partPath;
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
      const long finishTimedOut = dispatch_semaphore_wait(
          sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)));
      if (finishTimedOut != 0 &&
          writer.status != AVAssetWriterStatusCompleted) {
        // Previously this fell through silently: no rename, no error - the
        // recording just vanished. Report it like any other finalize failure.
        logRecorderEvent("finalize_timeout",
                         "finishWriting exceeded 15s (" +
                             std::string("status=") +
                             std::to_string((long)writer.status) + ")");
        std::lock_guard<std::mutex> lock(impl_->mutex);
        if (impl_->lastError.empty()) {
          impl_->lastError = "finalize_timeout";
        }
      }
      if (writer.status == AVAssetWriterStatusFailed && writer.error != nil) {
        logRecorderEvent("finish_failed",
                         describeError(writer.error, "finish_failed"));
        std::lock_guard<std::mutex> lock(impl_->mutex);
        impl_->lastError = [[writer.error localizedDescription] UTF8String]
                               ?: "finish_failed";
      } else if (writer.status == AVAssetWriterStatusCompleted &&
                 !partPath.empty() && !finalPath.empty()) {
        // REC-03: only a fully finalized file gets the real name. On failure
        // or crash the ".part" sidecar remains (its fMP4 fragments stay
        // playable) and never masquerades as a finished recording.
        NSFileManager *fm = [NSFileManager defaultManager];
        NSString *from = [NSString stringWithUTF8String:partPath.c_str()];
        NSString *to = [NSString stringWithUTF8String:finalPath.c_str()];
        [fm removeItemAtPath:to error:nil];
        NSError *renameError = nil;
        if (![fm moveItemAtPath:from toPath:to error:&renameError]) {
          logRecorderEvent("rename_failed",
                           describeError(renameError, "rename_failed"));
          std::lock_guard<std::mutex> lock(impl_->mutex);
          impl_->lastError =
              renameError != nil
                  ? ([[renameError localizedDescription] UTF8String]
                         ?: "rename_failed")
                  : "rename_failed";
        } else {
          logRecorderEvent("completed", finalPath);
        }
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
