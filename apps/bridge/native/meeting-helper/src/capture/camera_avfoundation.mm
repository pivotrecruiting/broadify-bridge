#include "capture/camera_source.h"

#if defined(__APPLE__)

#include "util/json_utils.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <mutex>

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

class AvFoundationCameraSource final : public CameraSource {
 public:
  AvFoundationCameraSource() = default;

  ~AvFoundationCameraSource() override {
    stop();
  }

  std::vector<CameraInfo> listCameras() override {
    @autoreleasepool {
      ensureAuthorization();
      NSArray<AVCaptureDevice *> *devices = BroadifyDiscoverVideoDevices();
      std::vector<CameraInfo> cameras;
      int index = 0;
      for (AVCaptureDevice *device in devices) {
        CameraInfo info;
        info.cameraIndex = index++;
        info.label = [[device localizedName] UTF8String] ?: "";
        info.cameraId = [[device uniqueID] UTF8String] ?: info.label;
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
      return cameras;
    }
  }

  bool selectCamera(int cameraIndex) override {
    std::lock_guard<std::mutex> lock(mutex_);
    selectedIndex_ = cameraIndex;
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height, uint32_t fps) override {
    @autoreleasepool {
      stop();
      if (!ensureAuthorization()) {
        setError("Camera permission was not granted.");
        return false;
      }

      const std::vector<CameraInfo> cameras = listCameras();
      const int resolvedIndex = cameraIndex >= 0 ? cameraIndex : selectedIndex_;
      if (resolvedIndex < 0 || resolvedIndex >= static_cast<int>(cameras.size())) {
        setError("Requested camera index is not available.");
        return false;
      }

      AVCaptureDevice *device = findDeviceByUniqueId(cameras[resolvedIndex].cameraId);
      if (device == nil) {
        setError("Requested camera device was not found.");
        return false;
      }

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
        selectedIndex_ = resolvedIndex;
        targetWidth_ = width;
        targetHeight_ = height;
        targetFps_ = fps;
        running_ = true;
        lastError_.clear();
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

  std::string lastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
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
    for (size_t y = 0; y < height; ++y) {
      const uint8_t *row = src + y * stride;
      uint8_t *dst = frame.rgba.data() + y * width * 4u;
      for (size_t x = 0; x < width; ++x) {
        dst[x * 4u + 0u] = row[x * 4u + 2u];
        dst[x * 4u + 1u] = row[x * 4u + 1u];
        dst[x * 4u + 2u] = row[x * 4u + 0u];
        dst[x * 4u + 3u] = row[x * 4u + 3u];
      }
    }
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    std::lock_guard<std::mutex> lock(mutex_);
    latestFrame_ = std::move(frame);
    hasFrame_ = true;
  }

 private:
  bool ensureAuthorization() {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusAuthorized) {
      return true;
    }
    if (status != AVAuthorizationStatusNotDetermined) {
      return false;
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL granted = NO;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL accessGranted) {
      granted = accessGranted;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    return granted == YES;
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

  void setError(const std::string &error) {
    std::lock_guard<std::mutex> lock(mutex_);
    lastError_ = error;
  }

  mutable std::mutex mutex_;
  bool running_ = false;
  bool hasFrame_ = false;
  int selectedIndex_ = 0;
  uint32_t targetWidth_ = 1280;
  uint32_t targetHeight_ = 720;
  uint32_t targetFps_ = 30;
  std::string lastError_;
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
