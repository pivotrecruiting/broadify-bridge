#include "recorder/meeting_recorder.h"

#if defined(__APPLE__)
#include "recorder/recorder_encode_policy.h"
#include "recorder/recorder_video_worker.h"
#include "recorder/recorder_writer_factory.h"
#endif

#include <chrono>
#include <cstdlib>
#include <memory>
#include <mutex>

#if defined(__APPLE__)
#include <sys/statvfs.h>

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
  // Counters of the last (or current) recording; while a worker is alive
  // status() reads the live values from it, these hold the final values
  // after stop so recording.status keeps reporting them.
  uint64_t videoFrames = 0;
  uint64_t droppedFrames = 0;
  uint64_t queuedFrames = 0;
  std::chrono::steady_clock::time_point startedAt;

  // Encodes the program frames on its own thread; appendVideoFrame only
  // copies into its mailbox. Shared so the pipeline thread can offer a
  // frame without holding the recorder mutex during the copy.
  std::shared_ptr<RecorderVideoWorker> videoWorker;

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
    videoWorker.reset();
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

    // Video encode worker: swizzle + CFR planning + writer append run on its
    // thread, fed by appendVideoFrame through a latest-wins mailbox.
    const char *cfrEnv = getenv("BROADIFY_MEETING_RECORDER_CFR");
    RecorderVideoWorker::Config workerConfig;
    workerConfig.writer = writer;
    workerConfig.videoInput = videoInput;
    workerConfig.videoAdaptor = adaptor;
    workerConfig.sessionStart = sessionStart;
    workerConfig.width = width;
    workerConfig.height = height;
    workerConfig.fps = safeFps;
    workerConfig.cfrEnabled = !(cfrEnv != nullptr && std::string(cfrEnv) == "0");
    auto videoWorker = std::make_shared<RecorderVideoWorker>(workerConfig);
    videoWorker->start();

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
    impl_->droppedFrames = 0;
    impl_->queuedFrames = 0;
    impl_->videoWorker = videoWorker;
    impl_->startedAt = std::chrono::steady_clock::now();
    impl_->lastError.clear();
    impl_->starting = false;
    impl_->active = true;
  }
  return true;
}

void MeetingRecorder::appendVideoFrame(const uint8_t *rgba, uint32_t width,
                                       uint32_t height) {
  // Pipeline thread. Only the bookkeeping runs under the recorder mutex; the
  // frame copy into the worker's mailbox (~0.2 ms at 1080p) runs without it
  // so the microphone callback is never blocked behind a frame copy.
  std::shared_ptr<RecorderVideoWorker> worker;
  CMTime sessionStart = kCMTimeInvalid;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active || rgba == nullptr) {
      return;
    }
    if (width != impl_->width || height != impl_->height) {
      return;  // geometry changed mid-recording; skip until it matches
    }
    worker = impl_->videoWorker;
    sessionStart = impl_->sessionStart;
  }
  if (worker == nullptr || !CMTIME_IS_VALID(sessionStart)) {
    return;
  }
  // Capture time relative to the writer session, taken NOW on the tick
  // thread: the worker plans the CFR grid from this value, so a slow encoder
  // shifts nothing on the recorded timeline.
  const CMTime now = CMClockGetTime(CMClockGetHostTimeClock());
  const double elapsedSeconds =
      CMTimeGetSeconds(CMTimeSubtract(now, sessionStart));
  const uint64_t elapsedNs =
      elapsedSeconds > 0.0
          ? static_cast<uint64_t>(elapsedSeconds * 1000000000.0)
          : 0ull;
  worker->offer(rgba, width, height, elapsedNs);
}

void MeetingRecorder::stop() {
  // Detach the capture pipeline first (outside the lock) so an in-flight audio
  // callback can finish and no new samples arrive, then drain the video
  // worker, then finalize the file.
  AVCaptureSession *micSession = nil;
  AVCaptureAudioDataOutput *audioOutput = nil;
  AVAssetWriter *writer = nil;
  AVAssetWriterInput *videoInput = nil;
  AVAssetWriterInput *audioInput = nil;
  std::shared_ptr<RecorderVideoWorker> worker;
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
    worker = impl_->videoWorker;
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

    // Stop accepting, drain the mailbox and join the worker BEFORE the
    // inputs are marked finished, so every frame the tick handed over is
    // either in the file or counted as dropped.
    RecorderVideoWorker::Counters counters;
    if (worker != nullptr) {
      worker->stop();
      counters = worker->counters();
      const std::string workerError = worker->lastError();
      std::lock_guard<std::mutex> lock(impl_->mutex);
      impl_->videoFrames = counters.videoFrames;
      impl_->droppedFrames = counters.droppedFrames;
      impl_->queuedFrames = 0;
      if (impl_->lastError.empty() && !workerError.empty()) {
        impl_->lastError = workerError;
      }
    }

    if (writer != nil) {
      const RecorderFinalizeResult result = finalizeRecorderWriter(
          writer, videoInput, audioInput, counters.videoFrames, partPath,
          finalPath, kRecorderFinalizeTimeoutMs);
      if (!result.error.empty()) {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        const bool overwrite =
            result.outcome == RecorderFinalizeOutcome::FinishFailed ||
            result.outcome == RecorderFinalizeOutcome::RenameFailed;
        if (overwrite || impl_->lastError.empty()) {
          impl_->lastError = result.error;
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
  if (impl_->videoWorker != nullptr) {
    const RecorderVideoWorker::Counters counters = impl_->videoWorker->counters();
    status.videoFrames = counters.videoFrames;
    status.droppedFrames = counters.droppedFrames;
    status.queuedFrames = counters.queuedFrames;
    if (impl_->lastError.empty()) {
      // REC-02: a writer failure seen by the worker streams to the webapp
      // through recording.status while the recording is still "active".
      status.lastError = impl_->videoWorker->lastError();
    } else {
      status.lastError = impl_->lastError;
    }
  } else {
    status.videoFrames = impl_->videoFrames;
    status.droppedFrames = impl_->droppedFrames;
    status.queuedFrames = impl_->queuedFrames;
    status.lastError = impl_->lastError;
  }
  status.elapsedSeconds = impl_->active ? secondsSince(impl_->startedAt) : 0.0;
  return status;
}

#endif  // __APPLE__

}  // namespace broadify::meeting
