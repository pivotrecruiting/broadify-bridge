#include "capture/camera_source.h"

#if defined(__APPLE__)

#include "capture/capture_format_selection.h"
#include "macos/macos_app.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"

#import <AVFoundation/AVFoundation.h>
#import <Accelerate/Accelerate.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace broadify::meeting {
class AvFoundationCameraSource;
}

@interface BroadifyCameraFrameDelegate : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner
                  cameraIndex:(int)cameraIndex;
@end

@interface BroadifyCameraAudioDelegate : NSObject <AVCaptureAudioDataOutputSampleBufferDelegate>
- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner
                  cameraIndex:(int)cameraIndex;
@end

static NSArray<AVCaptureDevice *> *BroadifyDiscoverVideoDevices() {
  NSMutableArray<AVCaptureDeviceType> *deviceTypes = [NSMutableArray arrayWithObject:AVCaptureDeviceTypeBuiltInWideAngleCamera];
  if (@available(macOS 14.0, *)) {
    [deviceTypes addObject:AVCaptureDeviceTypeExternal];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [deviceTypes addObject:AVCaptureDeviceTypeExternalUnknown];
#pragma clang diagnostic pop
  }
  AVCaptureDeviceDiscoverySession *session =
      [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:deviceTypes
                                                             mediaType:AVMediaTypeVideo
                                                              position:AVCaptureDevicePositionUnspecified];
  return session.devices;
}

namespace broadify::meeting {

namespace {

std::string lowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

bool isBroadifyVirtualCamera(const std::string &label, const std::string &uniqueId) {
  const std::string haystack = lowerAscii(label + " " + uniqueId);
  return haystack.find("com.broadify.vcam") != std::string::npos ||
         haystack.find("broadify camera") != std::string::npos ||
         haystack.find("broadify virtual camera") != std::string::npos;
}

std::string authorizationStatusToString(AVAuthorizationStatus status) {
  switch (status) {
    case AVAuthorizationStatusAuthorized:
      return "authorized";
    case AVAuthorizationStatusDenied:
      return "denied";
    case AVAuthorizationStatusRestricted:
      return "restricted";
    case AVAuthorizationStatusNotDetermined:
      return "not_determined";
  }
  return "unknown";
}

void emitCameraPermissionEvent(const std::string &status) {
  std::ostringstream event;
  event << "{\"type\":\"camera_permission_completed\",\"camera_permission_status\":\""
        << jsonEscape(status) << "\"}";
  emitHelperEvent(event.str());
}

void emitCameraSessionEvent(const char *type, int cameraIndex,
                            const std::string &reason) {
  std::ostringstream event;
  event << "{\"type\":\"" << type << "\",\"camera_index\":" << cameraIndex;
  if (!reason.empty()) {
    event << ",\"reason\":\"" << jsonEscape(reason) << "\"";
  }
  event << "}";
  emitHelperEvent(event.str());
}

void requestCameraAccessOnMainThread(void (^completion)(BOOL granted)) {
  void (^requestBlock)(void) = ^{
    prepareMacosCameraPermissionPrompt();
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:completion];
  };
  if ([NSThread isMainThread]) {
    requestBlock();
  } else {
    dispatch_async(dispatch_get_main_queue(), requestBlock);
  }
}

bool requestCameraAccessBlockingOnMainThread() {
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block BOOL granted = NO;
  requestCameraAccessOnMainThread(^(BOOL accessGranted) {
    granted = accessGranted;
    dispatch_semaphore_signal(semaphore);
  });
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  return granted == YES;
}

// V3 auto-director: microphone access is optional. Returns true only when the
// user has authorized it, so the audio path is skipped (rather than silently
// failing) when denied. Prompts once if the status is still undetermined.
bool ensureMicrophoneAuthorization() {
  const AVAuthorizationStatus status =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (status == AVAuthorizationStatusAuthorized) {
    return true;
  }
  if (status != AVAuthorizationStatusNotDetermined) {
    return false;
  }
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block BOOL granted = NO;
  void (^requestBlock)(void) = ^{
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL accessGranted) {
                               granted = accessGranted;
                               dispatch_semaphore_signal(semaphore);
                             }];
  };
  if ([NSThread isMainThread]) {
    requestBlock();
  } else {
    dispatch_async(dispatch_get_main_queue(), requestBlock);
  }
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  return granted == YES;
}

std::string fourccToString(FourCharCode code) {
  std::string text;
  for (int shift = 24; shift >= 0; shift -= 8) {
    const char ch = static_cast<char>((code >> shift) & 0xffu);
    text.push_back(std::isprint(static_cast<unsigned char>(ch)) ? ch : '?');
  }
  return text;
}

// Candidate list for the pure selector, parallel to device.formats.
std::vector<CaptureFormatCandidate> captureFormatCandidates(
    NSArray<AVCaptureDeviceFormat *> *formats) {
  std::vector<CaptureFormatCandidate> candidates;
  candidates.reserve([formats count]);
  for (AVCaptureDeviceFormat *format in formats) {
    CaptureFormatCandidate candidate;
    const CMVideoDimensions dimensions =
        CMVideoFormatDescriptionGetDimensions(format.formatDescription);
    candidate.width = dimensions.width > 0 ? static_cast<uint32_t>(dimensions.width) : 0u;
    candidate.height = dimensions.height > 0 ? static_cast<uint32_t>(dimensions.height) : 0u;
    candidate.pixelFormat =
        fourccToString(CMFormatDescriptionGetMediaSubType(format.formatDescription));
    for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
      candidate.frameRateRanges.push_back({range.minFrameRate, range.maxFrameRate});
    }
    candidates.push_back(std::move(candidate));
  }
  return candidates;
}

// What applyCaptureFormat chose and whether the device took it; feeds the
// camera_format_selected event.
struct AppliedCaptureFormat {
  CaptureFormatSelection selection;
  uint32_t width = 0;
  uint32_t height = 0;
  std::string pixelFormat;
  AVCaptureDeviceFormat *format = nil;
  CMTime frameDuration = kCMTimeInvalid;
  bool applied = false;
  // True when the read-back after startRunning showed the session had reset
  // the format and it was applied a second time.
  bool reapplied = false;
  std::string failure;
};

// Dimensions and rate the device currently reports as active.
struct ActiveCaptureFormat {
  uint32_t width = 0;
  uint32_t height = 0;
  double fps = 0.0;
  std::string pixelFormat;
};

ActiveCaptureFormat readActiveCaptureFormat(AVCaptureDevice *device) {
  ActiveCaptureFormat active;
  if (device == nil || device.activeFormat == nil) {
    return active;
  }
  const CMVideoDimensions dimensions =
      CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription);
  active.width = dimensions.width > 0 ? static_cast<uint32_t>(dimensions.width) : 0u;
  active.height = dimensions.height > 0 ? static_cast<uint32_t>(dimensions.height) : 0u;
  active.pixelFormat = fourccToString(
      CMFormatDescriptionGetMediaSubType(device.activeFormat.formatDescription));
  const CMTime duration = device.activeVideoMinFrameDuration;
  if (CMTIME_IS_VALID(duration) && duration.value > 0) {
    const double seconds = CMTimeGetSeconds(duration);
    active.fps = seconds > 0.0 ? 1.0 / seconds : 0.0;
  }
  return active;
}

// Locks the device and sets the format + frame duration. AVFoundation throws
// for a duration outside the format's ranges, so the call is guarded and a
// camera_format_apply_failed event replaces a crash.
bool applyFormatToDevice(AVCaptureDevice *device, AVCaptureDeviceFormat *format,
                         CMTime frameDuration, std::string &failure) {
  bool locked = false;
  @try {
    NSError *error = nil;
    if (![device lockForConfiguration:&error]) {
      failure = std::string("lock_failed: ") +
                (error != nil ? [[error localizedDescription] UTF8String] ?: "" : "");
      return false;
    }
    locked = true;
    device.activeFormat = format;
    device.activeVideoMinFrameDuration = frameDuration;
    device.activeVideoMaxFrameDuration = frameDuration;
    [device unlockForConfiguration];
    return true;
  } @catch (NSException *exception) {
    const char *reason = exception.reason != nil ? [exception.reason UTF8String] : nullptr;
    failure = std::string("exception: ") + (reason != nullptr ? reason : "");
    if (locked) {
      [device unlockForConfiguration];
    }
    return false;
  }
}

void emitCameraFormatApplyFailedEvent(int cameraIndex, const AppliedCaptureFormat &applied) {
  std::ostringstream event;
  event.precision(10);
  event << "{\"type\":\"camera_format_apply_failed\",\"camera_index\":" << cameraIndex
        << ",\"width\":" << applied.width << ",\"height\":" << applied.height
        << ",\"fps\":" << applied.selection.fps << ",\"reason\":\""
        << jsonEscape(applied.failure) << "\"}";
  emitHelperEvent(event.str());
}

// Frame duration for the chosen rate taken from the RANGE's own CMTime
// values: a 30.00003-30.00003 range rejects CMTimeMake(1, 30) (outside the
// range -> AVFoundation throws), so an endpoint rate uses the endpoint's
// duration and only a rate strictly inside a continuous range (always the
// integer request) is synthesized.
CMTime frameDurationForRate(AVFrameRateRange *range, double fps) {
  if (std::fabs(fps - range.maxFrameRate) <= 1e-9) {
    return range.minFrameDuration;
  }
  if (std::fabs(fps - range.minFrameRate) <= 1e-9) {
    return range.maxFrameDuration;
  }
  return CMTimeMake(1, static_cast<int32_t>(std::llround(fps)));
}

// Configures the device's active format and frame duration. Runs AFTER the
// device input is attached to the session and after the session preset was
// applied, so the preset (which may pick a format of its own) never wins over
// the explicit choice. AVCaptureSessionPresetInputPriority is iOS-only: on
// macOS the preset and the device's active format coexist, and the read-back
// after startRunning (verifyAppliedCaptureFormat) is the proof that the
// choice stuck. A selector "none" leaves the preset path untouched.
AppliedCaptureFormat applyCaptureFormat(AVCaptureDevice *device, int cameraIndex,
                                        uint32_t targetWidth,
                                        uint32_t targetHeight,
                                        uint32_t targetFps) {
  AppliedCaptureFormat result;
  if (device == nil) {
    result.failure = "no_device";
    return result;
  }
  NSArray<AVCaptureDeviceFormat *> *formats = device.formats;
  const std::vector<CaptureFormatCandidate> candidates =
      captureFormatCandidates(formats);
  result.selection = selectCaptureFormat(
      candidates, {targetWidth, targetHeight, static_cast<double>(targetFps)});
  if (result.selection.match == CaptureFormatMatch::None ||
      result.selection.candidateIndex < 0 ||
      static_cast<NSUInteger>(result.selection.candidateIndex) >= [formats count]) {
    return result;
  }
  const CaptureFormatCandidate &chosen =
      candidates[static_cast<size_t>(result.selection.candidateIndex)];
  result.width = chosen.width;
  result.height = chosen.height;
  result.pixelFormat = chosen.pixelFormat;
  result.format = formats[static_cast<NSUInteger>(result.selection.candidateIndex)];
  NSArray<AVFrameRateRange *> *ranges = result.format.videoSupportedFrameRateRanges;
  if (result.selection.rangeIndex < 0 ||
      static_cast<NSUInteger>(result.selection.rangeIndex) >= [ranges count]) {
    result.failure = "range_index_out_of_bounds";
    emitCameraFormatApplyFailedEvent(cameraIndex, result);
    return result;
  }
  AVFrameRateRange *range =
      ranges[static_cast<NSUInteger>(result.selection.rangeIndex)];
  result.frameDuration = frameDurationForRate(range, result.selection.fps);
  result.applied = applyFormatToDevice(device, result.format, result.frameDuration,
                                       result.failure);
  if (!result.applied) {
    emitCameraFormatApplyFailedEvent(cameraIndex, result);
  }
  return result;
}

// After startRunning: if the session reset the device format (macOS presets
// may reconfigure the device when the session starts), apply it once more.
// The device stays configurable while running.
void verifyAppliedCaptureFormat(AVCaptureDevice *device, int cameraIndex,
                                AppliedCaptureFormat &applied) {
  if (!applied.applied || device == nil || applied.format == nil) {
    return;
  }
  const ActiveCaptureFormat active = readActiveCaptureFormat(device);
  const bool matches = active.width == applied.width &&
                       active.height == applied.height &&
                       std::fabs(active.fps - applied.selection.fps) <= 0.05;
  if (matches) {
    return;
  }
  applied.reapplied = true;
  applied.applied = applyFormatToDevice(device, applied.format,
                                        applied.frameDuration, applied.failure);
  if (!applied.applied) {
    emitCameraFormatApplyFailedEvent(cameraIndex, applied);
  }
}

// One line per camera open: what was requested, what the selector chose and
// what the device reports back as active once the session runs. Parity with
// the Windows camera_native_media_type_selected event.
void emitCameraFormatSelectedEvent(int cameraIndex, AVCaptureDevice *device,
                                   AVCaptureSession *session,
                                   const AppliedCaptureFormat &applied,
                                   uint32_t requestedWidth,
                                   uint32_t requestedHeight,
                                   uint32_t requestedFps) {
  const ActiveCaptureFormat active = readActiveCaptureFormat(device);
  const bool chosen = applied.selection.match != CaptureFormatMatch::None;
  std::ostringstream event;
  event.precision(10);
  event << "{\"type\":\"camera_format_selected\",\"camera_index\":" << cameraIndex
        << ",\"width\":" << (chosen ? applied.width : active.width)
        << ",\"height\":" << (chosen ? applied.height : active.height)
        << ",\"fps\":" << (chosen ? applied.selection.fps : active.fps)
        << ",\"pixel_format\":\"" << jsonEscape(chosen ? applied.pixelFormat : active.pixelFormat)
        << "\",\"requested_width\":" << requestedWidth
        << ",\"requested_height\":" << requestedHeight
        << ",\"requested_fps\":" << requestedFps
        << ",\"match\":\"" << captureFormatMatchName(applied.selection.match)
        << "\",\"applied\":" << (applied.applied ? "true" : "false")
        << ",\"reapplied\":" << (applied.reapplied ? "true" : "false")
        << ",\"applied_width\":" << active.width
        << ",\"applied_height\":" << active.height
        << ",\"applied_fps\":" << active.fps
        << ",\"applied_pixel_format\":\"" << jsonEscape(active.pixelFormat) << "\""
        << ",\"session_preset\":\""
        << jsonEscape(session != nil && session.sessionPreset != nil
                          ? [session.sessionPreset UTF8String] ?: ""
                          : "")
        << "\"";
  if (!applied.failure.empty()) {
    event << ",\"reason\":\"" << jsonEscape(applied.failure) << "\"";
  }
  event << "}";
  emitHelperEvent(event.str());
}

}  // namespace

class AvFoundationCameraSource final : public CameraSource {
 public:
  AvFoundationCameraSource() = default;

  ~AvFoundationCameraSource() override {
    stop();
  }

  std::vector<CameraInfo> listCameras() override {
    @autoreleasepool {
      if (!ensureAuthorization()) {
        setError("Camera permission was not granted.", "denied");
        return {};
      }
      NSArray<AVCaptureDevice *> *devices = BroadifyDiscoverVideoDevices();
      std::vector<CameraInfo> cameras;
      int index = 0;
      for (AVCaptureDevice *device in devices) {
        const std::string label = [[device localizedName] UTF8String] ?: "";
        const std::string cameraId = [[device uniqueID] UTF8String] ?: label;
        if (isBroadifyVirtualCamera(label, cameraId)) {
          continue;
        }

        CameraInfo info;
        info.cameraIndex = index++;
        info.label = label;
        info.cameraId = cameraId;
        info.displayName = info.label;
        info.stableKey = info.cameraId;
        info.backend = "avfoundation";
        info.deviceName = info.label;
        info.builtinCandidate = device.position == AVCaptureDevicePositionFront;
        info.virtualCandidate = info.label.find("Virtual") != std::string::npos ||
                                info.label.find("OBS") != std::string::npos;
        info.continuityCandidate = info.label.find("Continuity") != std::string::npos ||
                                   info.label.find("iPhone") != std::string::npos;
        info.available = true;
        info.active = isRunning() && activeCameraIndex() == info.cameraIndex;
        cameras.push_back(info);
      }
      setError("", "authorized");
      return cameras;
    }
  }

  bool selectCamera(int cameraIndex) override {
    const std::vector<CameraInfo> cameras = listCameras();
    const auto camera = std::find_if(cameras.begin(), cameras.end(), [cameraIndex](const CameraInfo &info) {
      return info.cameraIndex == cameraIndex;
    });
    if (camera == cameras.end()) {
      setError("Requested camera index is not available.");
      return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    programIndex_ = camera->cameraIndex;
    lastError_.clear();
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height, uint32_t fps) override {
    const int resolvedIndex = cameraIndex >= 0 ? cameraIndex : programIndex_;
    return startSet({resolvedIndex}, width, height, fps);
  }

  bool startSet(const std::vector<int> &cameraIndices, uint32_t width,
                uint32_t height, uint32_t fps) override {
    @autoreleasepool {
      stop();
      if (cameraIndices.empty()) {
        setError("No cameras requested.");
        return false;
      }
      if (!ensureAuthorization()) {
        setError("Camera permission was not granted.", "denied");
        return false;
      }

      const std::vector<CameraInfo> cameras = listCameras();
      std::map<int, std::shared_ptr<CameraStream>> opened;
      for (int requestedIndex : cameraIndices) {
        const auto camera = std::find_if(
            cameras.begin(), cameras.end(),
            [requestedIndex](const CameraInfo &info) {
              return info.cameraIndex == requestedIndex;
            });
        if (camera == cameras.end()) {
          setError("Requested camera index is not available.");
          continue;
        }
        auto stream =
            openStream(camera->cameraIndex, camera->cameraId, width, height, fps);
        if (stream != nullptr) {
          opened[camera->cameraIndex] = stream;
        }
      }

      if (opened.empty()) {
        setError("No requested camera could be opened.");
        return false;
      }

      {
        std::lock_guard<std::mutex> lock(mutex_);
        streams_ = opened;
        programIndex_ = opened.count(cameraIndices.front())
                            ? cameraIndices.front()
                            : opened.begin()->first;
        targetWidth_ = width;
        targetHeight_ = height;
        targetFps_ = fps;
        running_ = true;
        lastError_.clear();
        permissionStatus_ = "authorized";
      }

      for (auto &entry : opened) {
        CameraStream &stream = *entry.second;
        [stream.session startRunning];
        // The read-back after startRunning is the evidence that the chosen
        // format/rate stuck (applied_* fields); a reset is applied once more.
        verifyAppliedCaptureFormat(stream.device, stream.cameraIndex,
                                   stream.appliedFormat);
        emitCameraFormatSelectedEvent(stream.cameraIndex, stream.device,
                                      stream.session, stream.appliedFormat,
                                      stream.requestedWidth,
                                      stream.requestedHeight,
                                      stream.requestedFps);
      }
      return true;
    }
  }

  void stop() override {
    @autoreleasepool {
      std::map<int, std::shared_ptr<CameraStream>> streams;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        streams.swap(streams_);
        running_ = false;
      }
      for (auto &entry : streams) {
        for (id token : entry.second->notificationTokens) {
          [[NSNotificationCenter defaultCenter] removeObserver:token];
        }
        entry.second->notificationTokens.clear();
        if (entry.second->output != nil) {
          [entry.second->output setSampleBufferDelegate:nil queue:nil];
        }
        if (entry.second->audioOutput != nil) {
          [entry.second->audioOutput setSampleBufferDelegate:nil queue:nil];
        }
        if (entry.second->session != nil) {
          [entry.second->session stopRunning];
        }
      }
    }
  }

  bool setProgramCamera(int cameraIndex) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (streams_.count(cameraIndex) == 0) {
      setErrorLocked("Requested program camera is not open.");
      return false;
    }
    // Seamless: all cameras are already running; only the program pointer moves.
    programIndex_ = cameraIndex;
    lastError_.clear();
    return true;
  }

  std::vector<int> activeCameraSet() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<int> indices;
    indices.reserve(streams_.size());
    for (const auto &entry : streams_) {
      indices.push_back(entry.first);
    }
    return indices;
  }

  bool copyLatestFrameFrom(int cameraIndex, uint64_t lastTimestampNs,
                           VideoFrame &frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = streams_.find(cameraIndex);
    if (it == streams_.end() || !it->second->hasFrame ||
        it->second->latestFrame.timestampNs == lastTimestampNs) {
      return false;
    }
    frame = it->second->latestFrame;
    return true;
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  int activeCameraIndex() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_ ? programIndex_ : -1;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = streams_.find(programIndex_);
    if (it == streams_.end() || !it->second->hasFrame) {
      return false;
    }
    frame = it->second->latestFrame;
    return true;
  }

  // Checks the timestamp before copying: the default implementation copies
  // the full frame (~3.7 MB) first and only then compares, which wastes a
  // copy on every poll where no new frame arrived.
  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = streams_.find(programIndex_);
    if (it == streams_.end() || !it->second->hasFrame ||
        it->second->latestFrame.timestampNs == lastTimestampNs) {
      return false;
    }
    frame = it->second->latestFrame;
    return true;
  }

  std::string lastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
  }

  std::string cameraPermissionStatus() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return permissionStatus_;
  }

  std::string requestCameraPermission() override {
    @autoreleasepool {
      AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
      if (status == AVAuthorizationStatusAuthorized) {
        setPermissionStatus("authorized");
        return "authorized";
      }
      if (status == AVAuthorizationStatusDenied) {
        setPermissionStatus("denied");
        setError("Camera permission was not granted.", "denied");
        return "denied";
      }
      if (status == AVAuthorizationStatusRestricted) {
        setPermissionStatus("restricted");
        setError("Camera permission is restricted by the system.", "restricted");
        return "restricted";
      }
      if (status != AVAuthorizationStatusNotDetermined) {
        setPermissionStatus("unknown");
        return "unknown";
      }

      setPermissionStatus("prompt_requested");
      AvFoundationCameraSource *owner = this;
      requestCameraAccessOnMainThread(^(BOOL accessGranted) {
        const std::string completedStatus = accessGranted == YES ? "authorized" : "denied";
        owner->setPermissionStatus(completedStatus);
        if (accessGranted != YES) {
          owner->setError("Camera permission was not granted.", "denied");
        }
        emitCameraPermissionEvent(completedStatus);
      });
      return "prompt_requested";
    }
  }

  void handleSampleBuffer(int cameraIndex, CMSampleBufferRef sampleBuffer) {
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (imageBuffer == nullptr) {
      return;
    }
    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    const size_t width = CVPixelBufferGetWidth(imageBuffer);
    const size_t height = CVPixelBufferGetHeight(imageBuffer);
    const size_t stride = CVPixelBufferGetBytesPerRow(imageBuffer);
    const auto *src = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(imageBuffer));
    if (src == nullptr || width == 0 || height == 0) {
      CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
      return;
    }

    VideoFrame frame;
    frame.width = static_cast<uint32_t>(width);
    frame.height = static_cast<uint32_t>(height);
    frame.timestampNs = nowNs();
    frame.rgba.resize(width * height * 4u);
    // SIMD-accelerated BGRA->RGBA swizzle; the scalar per-pixel loop cost
    // several milliseconds per frame at 30fps.
    vImage_Buffer sourceBuffer;
    sourceBuffer.data = const_cast<uint8_t *>(src);
    sourceBuffer.height = height;
    sourceBuffer.width = width;
    sourceBuffer.rowBytes = stride;
    vImage_Buffer destinationBuffer;
    destinationBuffer.data = frame.rgba.data();
    destinationBuffer.height = height;
    destinationBuffer.width = width;
    destinationBuffer.rowBytes = width * 4u;
    const uint8_t kBgraToRgba[4] = {2, 1, 0, 3};
    const vImage_Error permuteStatus =
        vImagePermuteChannels_ARGB8888(&sourceBuffer, &destinationBuffer, kBgraToRgba, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    if (permuteStatus != kvImageNoError) {
      return;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = streams_.find(cameraIndex);
    if (it == streams_.end()) {
      return;  // Stream was torn down between delivery and lock.
    }
    it->second->latestFrame = std::move(frame);
    it->second->hasFrame = true;
  }

  void handleAudioSample(int cameraIndex, CMSampleBufferRef sampleBuffer) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (block == nullptr) {
      return;
    }
    size_t length = 0;
    char *data = nullptr;
    if (CMBlockBufferGetDataPointer(block, 0, nullptr, &length, &data) !=
            kCMBlockBufferNoErr ||
        data == nullptr || length == 0) {
      return;
    }

    // AVCaptureAudioDataOutput delivers linear PCM but the concrete format
    // varies by device (macOS defaults to 32-bit float; some mics deliver
    // 16-bit signed int). Read the actual sample layout instead of assuming.
    CMFormatDescriptionRef format =
        CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd =
        format != nullptr
            ? CMAudioFormatDescriptionGetStreamBasicDescription(format)
            : nullptr;
    if (asbd == nullptr) {
      return;
    }
    const bool isFloat =
        (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    const uint32_t bits = asbd->mBitsPerChannel;

    double sumSquares = 0.0;
    size_t count = 0;
    if (isFloat && bits == 32) {
      const float *samples = reinterpret_cast<const float *>(data);
      count = length / sizeof(float);
      for (size_t i = 0; i < count; ++i) {
        sumSquares += static_cast<double>(samples[i]) * samples[i];
      }
    } else if (!isFloat && bits == 16) {
      const int16_t *samples = reinterpret_cast<const int16_t *>(data);
      count = length / sizeof(int16_t);
      for (size_t i = 0; i < count; ++i) {
        const double s = samples[i] / 32768.0;
        sumSquares += s * s;
      }
    } else if (!isFloat && bits == 32) {
      const int32_t *samples = reinterpret_cast<const int32_t *>(data);
      count = length / sizeof(int32_t);
      for (size_t i = 0; i < count; ++i) {
        const double s = samples[i] / 2147483648.0;
        sumSquares += s * s;
      }
    } else {
      return;  // Unsupported layout — leave the level unchanged.
    }
    const float rms =
        count > 0 ? static_cast<float>(std::sqrt(sumSquares / count)) : 0.0f;

    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = streams_.find(cameraIndex);
    if (it == streams_.end()) {
      return;
    }
    // Exponential smoothing so brief transients do not dominate.
    it->second->audioLevel = 0.6f * it->second->audioLevel + 0.4f * rms;
  }

 private:
  void setErrorLocked(const std::string &error) { lastError_ = error; }

  bool ensureAuthorization() {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusAuthorized) {
      setPermissionStatus("authorized");
      return true;
    }
    if (status != AVAuthorizationStatusNotDetermined) {
      setPermissionStatus(authorizationStatusToString(status));
      return false;
    }
    setPermissionStatus("not_determined");
    const bool granted = requestCameraAccessBlockingOnMainThread();
    const std::string completedStatus = granted ? "authorized" : "denied";
    setPermissionStatus(completedStatus);
    emitCameraPermissionEvent(completedStatus);
    return granted;
  }

  AVCaptureDevice *findDeviceByUniqueId(const std::string &uniqueId) {
    NSString *target = [NSString stringWithUTF8String:uniqueId.c_str()];
    NSArray<AVCaptureDevice *> *devices = BroadifyDiscoverVideoDevices();
    for (AVCaptureDevice *device in devices) {
      if ([[device uniqueID] isEqualToString:target]) {
        return device;
      }
    }
    return nil;
  }

  void setPermissionStatus(const std::string &status) {
    std::lock_guard<std::mutex> lock(mutex_);
    permissionStatus_ = status;
  }

  void setError(const std::string &error, const std::string &permissionStatus = "") {
    std::lock_guard<std::mutex> lock(mutex_);
    lastError_ = error;
    if (!permissionStatus.empty()) {
      permissionStatus_ = permissionStatus;
    }
  }

  // One open camera. Each holds its own AVFoundation objects and a private
  // dispatch queue (a shared queue throttled the measured fps from 30 to 21).
  struct CameraStream {
    int cameraIndex = -1;
    AVCaptureDevice *device = nil;
    AVCaptureSession *session = nil;
    AVCaptureDeviceInput *input = nil;
    // Capture format chosen at open; verified and reported after startRunning.
    AppliedCaptureFormat appliedFormat;
    uint32_t requestedWidth = 0;
    uint32_t requestedHeight = 0;
    uint32_t requestedFps = 0;
    AVCaptureVideoDataOutput *output = nil;
    BroadifyCameraFrameDelegate *delegate = nil;
    dispatch_queue_t queue = nil;
    VideoFrame latestFrame;
    bool hasFrame = false;
    // V3 auto-director: paired microphone level (smoothed RMS, 0..1).
    AVCaptureDeviceInput *audioInput = nil;
    AVCaptureAudioDataOutput *audioOutput = nil;
    BroadifyCameraAudioDelegate *audioDelegate = nil;
    dispatch_queue_t audioQueue = nil;
    float audioLevel = 0.0f;
    std::vector<id> notificationTokens;
  };

  // Opens a camera device into a new stream (not yet added to streams_).
  std::shared_ptr<CameraStream> openStream(int cameraIndex,
                                           const std::string &cameraId,
                                           uint32_t width, uint32_t height,
                                           uint32_t fps) {
    AVCaptureDevice *device = findDeviceByUniqueId(cameraId);
    if (device == nil) {
      setError("Requested camera device was not found.");
      return nullptr;
    }

    NSError *inputError = nil;
    AVCaptureDeviceInput *input =
        [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
    if (input == nil) {
      setError(inputError != nil
                   ? [[inputError localizedDescription] UTF8String]
                   : "Could not create camera input.");
      return nullptr;
    }

    AVCaptureSession *session = [[AVCaptureSession alloc] init];
    session.sessionPreset = AVCaptureSessionPresetHigh;
    if (![session canAddInput:input]) {
      setError("Camera input cannot be added to capture session.");
      return nullptr;
    }
    [session addInput:input];
    AVCaptureSessionPreset requestedPreset =
        width <= 1280u && height <= 720u ? AVCaptureSessionPreset1280x720
                                         : AVCaptureSessionPreset1920x1080;
    if ([session canSetSessionPreset:requestedPreset]) {
      session.sessionPreset = requestedPreset;
    }
    // Device format + frame rate: after addInput and after the preset (see
    // applyCaptureFormat). The former order (configure before addInput, preset
    // afterwards) let the preset reset the frame duration, and the exact fps
    // match never accepted the Cam Link's 30.00003 so nothing was configured.
    const AppliedCaptureFormat appliedFormat =
        applyCaptureFormat(device, cameraIndex, width, height, fps);

    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.alwaysDiscardsLateVideoFrames = YES;
    output.videoSettings = @{
      (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey:
          @(kCVPixelFormatType_32BGRA)
    };
    if (![session canAddOutput:output]) {
      setError("Camera output cannot be added to capture session.");
      return nullptr;
    }
    [session addOutput:output];

    auto stream = std::make_shared<CameraStream>();
    stream->cameraIndex = cameraIndex;
    stream->device = device;
    stream->session = session;
    stream->input = input;
    stream->appliedFormat = appliedFormat;
    stream->requestedWidth = width;
    stream->requestedHeight = height;
    stream->requestedFps = fps;
    stream->output = output;
    stream->queue = dispatch_queue_create(
        [[NSString stringWithFormat:@"com.broadify.meeting.camera.%d",
                                    cameraIndex] UTF8String],
        DISPATCH_QUEUE_SERIAL);
    stream->delegate =
        [[BroadifyCameraFrameDelegate alloc] initWithOwner:this
                                               cameraIndex:cameraIndex];
    [output setSampleBufferDelegate:stream->delegate queue:stream->queue];

    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    id interruptedToken = [center
        addObserverForName:AVCaptureSessionWasInterruptedNotification
                    object:session
                     queue:nil
                usingBlock:^(NSNotification *note) {
                  (void)note;
                  std::string reason = "session_interrupted";
                  emitCameraSessionEvent("camera_interrupted", cameraIndex,
                                         reason);
                }];
    id endedToken = [center
        addObserverForName:AVCaptureSessionInterruptionEndedNotification
                    object:session
                     queue:nil
                usingBlock:^(__unused NSNotification *note) {
                  emitCameraSessionEvent("camera_resumed", cameraIndex, "");
                }];
    id runtimeErrorToken = [center
        addObserverForName:AVCaptureSessionRuntimeErrorNotification
                    object:session
                     queue:nil
                usingBlock:^(NSNotification *note) {
                  NSError *error = note.userInfo[AVCaptureSessionErrorKey];
                  const char *message =
                      error != nil ? error.localizedDescription.UTF8String : "";
                  emitCameraSessionEvent("camera_runtime_error", cameraIndex,
                                         message != nullptr ? message : "");
                }];
    stream->notificationTokens = {interruptedToken, endedToken,
                                  runtimeErrorToken};

    // V3 auto-director: attach the camera's paired microphone (matched by
    // device name) so we can measure per-camera speech level. Best-effort —
    // cameras without a microphone simply report a zero level.
    const bool micAuthorized = ensureMicrophoneAuthorization();
    AVCaptureDevice *audioDevice =
        micAuthorized ? findMatchingAudioDevice(device) : nil;
    if (audioDevice != nil) {
      NSError *audioError = nil;
      AVCaptureDeviceInput *audioInput =
          [AVCaptureDeviceInput deviceInputWithDevice:audioDevice
                                                error:&audioError];
      if (audioInput != nil && [session canAddInput:audioInput]) {
        [session addInput:audioInput];
        AVCaptureAudioDataOutput *audioOutput =
            [[AVCaptureAudioDataOutput alloc] init];
        stream->audioQueue = dispatch_queue_create(
            [[NSString stringWithFormat:@"com.broadify.meeting.audio.%d",
                                        cameraIndex] UTF8String],
            DISPATCH_QUEUE_SERIAL);
        stream->audioDelegate = [[BroadifyCameraAudioDelegate alloc]
            initWithOwner:this
              cameraIndex:cameraIndex];
        [audioOutput setSampleBufferDelegate:stream->audioDelegate
                                       queue:stream->audioQueue];
        if ([session canAddOutput:audioOutput]) {
          [session addOutput:audioOutput];
          stream->audioInput = audioInput;
          stream->audioOutput = audioOutput;
        }
      }
    }
    return stream;
  }

  // Finds the microphone paired with a camera: prefer one whose name shares a
  // meaningful prefix (e.g. "iPhone" camera <-> "Mikrofon von iPhone"), else a
  // same-manufacturer external mic. Returns nil when nothing matches.
  AVCaptureDevice *findMatchingAudioDevice(AVCaptureDevice *cameraDevice) {
    NSString *cameraName = [cameraDevice localizedName];
    if (cameraName.length == 0) {
      return nil;
    }
    NSArray<AVCaptureDevice *> *audioDevices = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
          AVCaptureDeviceTypeBuiltInMicrophone,
          AVCaptureDeviceTypeExternalUnknown
        ]
                              mediaType:AVMediaTypeAudio
                               position:AVCaptureDevicePositionUnspecified]
        .devices;
    for (AVCaptureDevice *audio in audioDevices) {
      NSString *audioName = [audio localizedName];
      // Match on any shared word >= 4 chars (e.g. "iPhone", device brand).
      for (NSString *word in
           [cameraName componentsSeparatedByString:@" "]) {
        if (word.length >= 4 &&
            [audioName rangeOfString:word
                             options:NSCaseInsensitiveSearch]
                    .location != NSNotFound) {
          return audio;
        }
      }
    }
    return nil;
  }

  std::map<int, float> cameraAudioLevels() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    std::map<int, float> levels;
    for (const auto &entry : streams_) {
      levels[entry.first] = entry.second->audioLevel;
    }
    return levels;
  }

  mutable std::mutex mutex_;
  bool running_ = false;
  int programIndex_ = 0;
  uint32_t targetWidth_ = 1280;
  uint32_t targetHeight_ = 720;
  uint32_t targetFps_ = 30;
  std::string lastError_;
  std::string permissionStatus_ = "unknown";
  // All currently open cameras, keyed by camera index. programIndex_ selects
  // which one feeds copyLatestFrame (the program feed).
  std::map<int, std::shared_ptr<CameraStream>> streams_;
};

}  // namespace broadify::meeting

@implementation BroadifyCameraFrameDelegate {
  broadify::meeting::AvFoundationCameraSource *_owner;
  int _cameraIndex;
}

- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner
                  cameraIndex:(int)cameraIndex {
  self = [super init];
  if (self) {
    _owner = owner;
    _cameraIndex = cameraIndex;
  }
  return self;
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  (void)output;
  (void)connection;
  if (_owner != nullptr) {
    _owner->handleSampleBuffer(_cameraIndex, sampleBuffer);
  }
}

@end

@implementation BroadifyCameraAudioDelegate {
  broadify::meeting::AvFoundationCameraSource *_owner;
  int _cameraIndex;
}

- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner
                  cameraIndex:(int)cameraIndex {
  self = [super init];
  if (self) {
    _owner = owner;
    _cameraIndex = cameraIndex;
  }
  return self;
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  (void)output;
  (void)connection;
  if (_owner != nullptr) {
    _owner->handleAudioSample(_cameraIndex, sampleBuffer);
  }
}

@end

namespace broadify::meeting {

std::unique_ptr<CameraSource> createCameraSource() {
  return std::make_unique<AvFoundationCameraSource>();
}

}  // namespace broadify::meeting

#endif
