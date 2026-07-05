#include "capture/camera_source.h"

#if defined(__APPLE__)

#include "macos/macos_app.h"
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
#include <mutex>
#include <sstream>

namespace broadify::meeting {
class AvFoundationCameraSource;
}

@interface BroadifyCameraFrameDelegate : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner;
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
  std::cout << event.str() << std::endl;
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

void configureCaptureFormat(AVCaptureDevice *device, uint32_t targetWidth, uint32_t targetHeight, uint32_t targetFps) {
  if (device == nil || targetWidth == 0u || targetHeight == 0u || targetFps == 0u) {
    return;
  }

  AVCaptureDeviceFormat *bestFormat = nil;
  double bestScore = std::numeric_limits<double>::max();
  for (AVCaptureDeviceFormat *format in device.formats) {
    const CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
    if (dimensions.width <= 0 || dimensions.height <= 0) {
      continue;
    }
    bool supportsFps = false;
    for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
      if (range.minFrameRate <= static_cast<double>(targetFps) &&
          range.maxFrameRate >= static_cast<double>(targetFps)) {
        supportsFps = true;
        break;
      }
    }
    if (!supportsFps) {
      continue;
    }

    const double widthDelta = std::abs(static_cast<double>(dimensions.width) - targetWidth);
    const double heightDelta = std::abs(static_cast<double>(dimensions.height) - targetHeight);
    const bool belowTarget = dimensions.width < static_cast<int32_t>(targetWidth) ||
        dimensions.height < static_cast<int32_t>(targetHeight);
    const double score = widthDelta + heightDelta + (belowTarget ? 1000000.0 : 0.0);
    if (score < bestScore) {
      bestScore = score;
      bestFormat = format;
    }
  }

  if (bestFormat == nil) {
    return;
  }

  NSError *error = nil;
  if (![device lockForConfiguration:&error]) {
    return;
  }
  device.activeFormat = bestFormat;
  const CMTime frameDuration = CMTimeMake(1, static_cast<int32_t>(targetFps));
  device.activeVideoMinFrameDuration = frameDuration;
  device.activeVideoMaxFrameDuration = frameDuration;
  [device unlockForConfiguration];
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
    selectedIndex_ = camera->cameraIndex;
    lastError_.clear();
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height, uint32_t fps) override {
    @autoreleasepool {
      stop();
      if (!ensureAuthorization()) {
        setError("Camera permission was not granted.", "denied");
        return false;
      }

      const std::vector<CameraInfo> cameras = listCameras();
      const int resolvedIndex = cameraIndex >= 0 ? cameraIndex : selectedIndex_;
      const auto camera = std::find_if(cameras.begin(), cameras.end(), [resolvedIndex](const CameraInfo &info) {
        return info.cameraIndex == resolvedIndex;
      });
      if (camera == cameras.end()) {
        setError("Requested camera index is not available.");
        return false;
      }

      AVCaptureDevice *device = findDeviceByUniqueId(camera->cameraId);
      if (device == nil) {
        setError("Requested camera device was not found.");
        return false;
      }

      configureCaptureFormat(device, width, height, fps);

      NSError *inputError = nil;
      AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
      if (input == nil) {
        setError(inputError != nil ? [[inputError localizedDescription] UTF8String] : "Could not create camera input.");
        return false;
      }

      AVCaptureSession *session = [[AVCaptureSession alloc] init];
      session.sessionPreset = AVCaptureSessionPresetHigh;
      if (![session canAddInput:input]) {
        setError("Camera input cannot be added to capture session.");
        return false;
      }
      [session addInput:input];
      AVCaptureSessionPreset requestedPreset =
          width <= 1280u && height <= 720u
              ? AVCaptureSessionPreset1280x720
              : AVCaptureSessionPreset1920x1080;
      if ([session canSetSessionPreset:requestedPreset]) {
        session.sessionPreset = requestedPreset;
      }

      AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
      output.alwaysDiscardsLateVideoFrames = YES;
      output.videoSettings = @{
        (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)
      };
      if (![session canAddOutput:output]) {
        setError("Camera output cannot be added to capture session.");
        return false;
      }
      [session addOutput:output];

      dispatch_queue_t queue = dispatch_queue_create("com.broadify.meeting.camera", DISPATCH_QUEUE_SERIAL);
      BroadifyCameraFrameDelegate *delegate = [[BroadifyCameraFrameDelegate alloc] initWithOwner:this];
      [output setSampleBufferDelegate:delegate queue:queue];

      {
        std::lock_guard<std::mutex> lock(mutex_);
        session_ = session;
        input_ = input;
        output_ = output;
        delegate_ = delegate;
        queue_ = queue;
        selectedIndex_ = camera->cameraIndex;
        targetWidth_ = width;
        targetHeight_ = height;
        targetFps_ = fps;
        running_ = true;
        lastError_.clear();
        permissionStatus_ = "authorized";
      }

      [session startRunning];
      return true;
    }
  }

  void stop() override {
    @autoreleasepool {
      AVCaptureSession *session = nil;
      AVCaptureVideoDataOutput *output = nil;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        session = session_;
        output = output_;
        running_ = false;
        session_ = nil;
        input_ = nil;
        output_ = nil;
        delegate_ = nil;
        queue_ = nil;
        latestFrame_.rgba.clear();
      }
      if (output != nil) {
        [output setSampleBufferDelegate:nil queue:nil];
      }
      if (session != nil) {
        [session stopRunning];
      }
    }
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  int activeCameraIndex() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_ ? selectedIndex_ : -1;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasFrame_) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

  // Checks the timestamp before copying: the default implementation copies
  // the full frame (~3.7 MB) first and only then compares, which wastes a
  // copy on every poll where no new frame arrived.
  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasFrame_ || latestFrame_.timestampNs == lastTimestampNs) {
      return false;
    }
    frame = latestFrame_;
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

  void handleSampleBuffer(CMSampleBufferRef sampleBuffer) {
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
    latestFrame_ = std::move(frame);
    hasFrame_ = true;
  }

 private:
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

  mutable std::mutex mutex_;
  bool running_ = false;
  bool hasFrame_ = false;
  int selectedIndex_ = 0;
  uint32_t targetWidth_ = 1280;
  uint32_t targetHeight_ = 720;
  uint32_t targetFps_ = 30;
  std::string lastError_;
  std::string permissionStatus_ = "unknown";
  VideoFrame latestFrame_;
  AVCaptureSession *session_ = nil;
  AVCaptureDeviceInput *input_ = nil;
  AVCaptureVideoDataOutput *output_ = nil;
  BroadifyCameraFrameDelegate *delegate_ = nil;
  dispatch_queue_t queue_ = nil;
};

}  // namespace broadify::meeting

@implementation BroadifyCameraFrameDelegate {
  broadify::meeting::AvFoundationCameraSource *_owner;
}

- (instancetype)initWithOwner:(broadify::meeting::AvFoundationCameraSource *)owner {
  self = [super init];
  if (self) {
    _owner = owner;
  }
  return self;
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  (void)output;
  (void)connection;
  if (_owner != nullptr) {
    _owner->handleSampleBuffer(sampleBuffer);
  }
}

@end

namespace broadify::meeting {

std::unique_ptr<CameraSource> createCameraSource() {
  return std::make_unique<AvFoundationCameraSource>();
}

}  // namespace broadify::meeting

#endif
