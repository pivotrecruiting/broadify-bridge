#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "common/monotonic_clock.h"
#include "capture/video_source.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#include <algorithm>
#include <mutex>

namespace broadify::pgm {
namespace {

uint64_t cmTimeToHostNs(CMTime time) {
  if (!CMTIME_IS_VALID(time) || time.timescale <= 0) {
    return monotonicNowNs();
  }
  // Presentation timestamps of AVCaptureVideoDataOutput are on the host clock.
  return static_cast<uint64_t>(CMTimeGetSeconds(time) * 1e9);
}

NSArray<AVCaptureDevice *> *discoverVideoDevices() {
  NSMutableArray<AVCaptureDeviceType> *types = [NSMutableArray arrayWithObject:AVCaptureDeviceTypeBuiltInWideAngleCamera];
  if (@available(macOS 14.0, *)) {
    [types addObject:AVCaptureDeviceTypeExternal];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [types addObject:AVCaptureDeviceTypeExternalUnknown];
#pragma clang diagnostic pop
  }
  AVCaptureDeviceDiscoverySession *session =
      [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:types
                                                             mediaType:AVMediaTypeVideo
                                                              position:AVCaptureDevicePositionUnspecified];
  return session.devices;
}

bool isBroadifyVirtualCamera(NSString *name, NSString *uniqueId) {
  NSString *haystack = [[name stringByAppendingFormat:@" %@", uniqueId] lowercaseString];
  return [haystack containsString:@"com.broadify.vcam"] || [haystack containsString:@"broadify camera"] ||
         [haystack containsString:@"broadify virtual camera"];
}

std::string authorizationString(AVAuthorizationStatus status) {
  switch (status) {
    case AVAuthorizationStatusAuthorized: return "authorized";
    case AVAuthorizationStatusDenied: return "denied";
    case AVAuthorizationStatusRestricted: return "restricted";
    case AVAuthorizationStatusNotDetermined: return "not_determined";
  }
  return "unknown";
}

std::string fourccToPixelFormat(OSType fourcc) {
  switch (fourcc) {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange: return "nv12";
    case kCVPixelFormatType_422YpCbCr8: return "uyvy";
    case kCVPixelFormatType_422YpCbCr8_yuvs: return "yuy2";
    case kCVPixelFormatType_32BGRA: return "bgra";
    default: return "unknown";
  }
}

/**
 * Picks the device format: highest resolution up to 1080 lines, then highest
 * frame rate, preferring native 4:2:0 (420v/420f) over 2vuy/yuvs/MJPEG so the
 * encoder gets NV12 without a CPU conversion. ATEM Mini / RØDECaster announce
 * exactly one resolution per video standard, so this lands on the live format.
 */
AVCaptureDeviceFormat *chooseFormat(AVCaptureDevice *device, double &chosenFps) {
  AVCaptureDeviceFormat *best = nil;
  double bestScore = -1.0;
  chosenFps = 0.0;
  for (AVCaptureDeviceFormat *format in device.formats) {
    const CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
    if (dims.height > 1080 || dims.width <= 0 || dims.height <= 0) {
      continue;
    }
    double maxFps = 0.0;
    for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
      maxFps = std::max(maxFps, range.maxFrameRate);
    }
    const OSType fourcc = CMFormatDescriptionGetMediaSubType(format.formatDescription);
    const std::string pixel = fourccToPixelFormat(fourcc);
    const double formatBonus = pixel == "nv12" ? 2.0 : (pixel == "uyvy" || pixel == "yuy2") ? 1.0 : 0.0;
    const double score = static_cast<double>(dims.width) * dims.height * 1000.0 + maxFps * 10.0 + formatBonus;
    if (score > bestScore) {
      bestScore = score;
      best = format;
      chosenFps = maxFps;
    }
  }
  return best;
}

}  // namespace
}  // namespace broadify::pgm

@interface BroadifyPgmFrameDelegate : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic, assign) std::function<void(CMSampleBufferRef)> *handler;
@end

@implementation BroadifyPgmFrameDelegate
- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
  if (self.handler != nullptr) {
    (*self.handler)(sampleBuffer);
  }
}
@end

namespace broadify::pgm {
namespace {

class UvcVideoSource final : public VideoSource {
 public:
  explicit UvcVideoSource(AVCaptureDevice *device) : device_(device) {}
  ~UvcVideoSource() override { stop(); }

  bool start(FrameSink sink, std::string &errorCode, std::string &error) override {
    @autoreleasepool {
      std::lock_guard<std::mutex> lock(mutex_);
      if (session_ != nil) {
        return true;
      }
      sink_ = std::move(sink);
      double fps = 0.0;
      AVCaptureDeviceFormat *format = chooseFormat(device_, fps);
      if (format == nil) {
        errorCode = "unsupported_format";
        error = "The device offers no usable video format (up to 1080p).";
        return false;
      }
      NSError *lockError = nil;
      if ([device_ lockForConfiguration:&lockError]) {
        device_.activeFormat = format;
        if (fps > 0.0) {
          // Lock to the format's maximum rate: the switcher delivers exactly its video standard.
          const CMTime duration = CMTimeMake(1000, static_cast<int32_t>(fps * 1000.0));
          device_.activeVideoMinFrameDuration = duration;
          device_.activeVideoMaxFrameDuration = duration;
        }
        [device_ unlockForConfiguration];
      }
      NSError *inputError = nil;
      AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device_ error:&inputError];
      if (input == nil) {
        errorCode = "device_in_use";
        error = inputError != nil ? [[inputError localizedDescription] UTF8String] : "Could not open the video input.";
        return false;
      }
      AVCaptureSession *session = [[AVCaptureSession alloc] init];
      // No session preset on macOS: the device's activeFormat (set above) decides the delivered format.
      if (![session canAddInput:input]) {
        errorCode = "device_in_use";
        error = "Video input cannot be added to the capture session.";
        return false;
      }
      [session addInput:input];
      AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
      output.alwaysDiscardsLateVideoFrames = YES;
      // NV12 (420v): the one conversion AVFoundation does happens device/ISP side; VideoToolbox takes it as is.
      output.videoSettings = @{(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)};
      if (![session canAddOutput:output]) {
        errorCode = "unsupported_format";
        error = "Video output cannot be added to the capture session.";
        return false;
      }
      [session addOutput:output];
      handler_ = [this](CMSampleBufferRef sample) { deliver(sample); };
      delegate_ = [[BroadifyPgmFrameDelegate alloc] init];
      delegate_.handler = &handler_;
      queue_ = dispatch_queue_create("com.broadify.pgm.capture", DISPATCH_QUEUE_SERIAL);
      [output setSampleBufferDelegate:delegate_ queue:queue_];
      [session startRunning];
      session_ = session;
      input_ = input;
      output_ = output;
      return true;
    }
  }

  void stop() override {
    @autoreleasepool {
      std::lock_guard<std::mutex> lock(mutex_);
      if (session_ == nil) {
        return;
      }
      [session_ stopRunning];
      [output_ setSampleBufferDelegate:nil queue:nil];
      session_ = nil;
      input_ = nil;
      output_ = nil;
      delegate_ = nil;
      queue_ = nil;
      sink_ = nullptr;
    }
  }

  bool isRunning() const override { return session_ != nil; }

 private:
  void deliver(CMSampleBufferRef sample) {
    CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (image == nullptr) {
      return;
    }
    CapturedFrame frame;
    frame.pixelBuffer = image;
    frame.width = static_cast<uint32_t>(CVPixelBufferGetWidth(image));
    frame.height = static_cast<uint32_t>(CVPixelBufferGetHeight(image));
    frame.pixelFormat = fourccToPixelFormat(CVPixelBufferGetPixelFormatType(image));
    frame.captureNs = cmTimeToHostNs(CMSampleBufferGetPresentationTimeStamp(sample));
    FrameSink sink;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      sink = sink_;
    }
    if (sink) {
      sink(frame);
    }
  }

  AVCaptureDevice *device_ = nil;
  AVCaptureSession *session_ = nil;
  AVCaptureDeviceInput *input_ = nil;
  AVCaptureVideoDataOutput *output_ = nil;
  BroadifyPgmFrameDelegate *delegate_ = nil;
  dispatch_queue_t queue_ = nil;
  std::function<void(CMSampleBufferRef)> handler_;
  FrameSink sink_;
  mutable std::mutex mutex_;
};

class UvcEnumerator final : public VideoInputEnumerator {
 public:
  UvcEnumerator() {
    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    for (NSNotificationName name in @[ AVCaptureDeviceWasConnectedNotification, AVCaptureDeviceWasDisconnectedNotification ]) {
      id token = [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *) {
        std::function<void()> handler;
        {
          std::lock_guard<std::mutex> lock(mutex_);
          handler = changeHandler_;
        }
        if (handler) {
          handler();
        }
      }];
      tokens_.push_back(token);
    }
  }

  ~UvcEnumerator() override {
    for (id token : tokens_) {
      [[NSNotificationCenter defaultCenter] removeObserver:token];
    }
  }

  std::vector<VideoInputInfo> list() override {
    @autoreleasepool {
      std::vector<VideoInputInfo> inputs;
      for (AVCaptureDevice *device in discoverVideoDevices()) {
        NSString *name = device.localizedName ?: @"";
        NSString *uniqueId = device.uniqueID ?: name;
        if (isBroadifyVirtualCamera(name, uniqueId)) {
          continue;
        }
        VideoInputInfo info;
        info.kind = "uvc";
        info.displayName = [name UTF8String] ?: "";
        info.deviceId = [uniqueId UTF8String] ?: "";
        info.stableKey = info.deviceId;
        info.id = "uvc:" + info.stableKey;
        info.available = device.connected;
        info.inUse = device.inUseByAnotherApplication;
        inputs.push_back(info);
      }
      return inputs;
    }
  }

  void setChangeHandler(std::function<void()> handler) override {
    std::lock_guard<std::mutex> lock(mutex_);
    changeHandler_ = std::move(handler);
  }

  std::string ensureCameraAuthorization() override {
    const AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status != AVAuthorizationStatusNotDetermined) {
      return authorizationString(status);
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL granted = NO;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL ok) {
      granted = ok;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC));
    const std::string result = granted ? "authorized" : authorizationString([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]);
    broadify::helper::emitHelperEvent("{\"type\":\"camera_permission_completed\",\"camera_permission_status\":\"" + broadify::helper::jsonEscape(result) + "\"}");
    return result;
  }

  std::unique_ptr<VideoSource> open(const std::string &stableKey) override {
    @autoreleasepool {
      for (AVCaptureDevice *device in discoverVideoDevices()) {
        if ([device.uniqueID isEqualToString:[NSString stringWithUTF8String:stableKey.c_str()]]) {
          return std::make_unique<UvcVideoSource>(device);
        }
      }
      return nullptr;
    }
  }

 private:
  std::function<void()> changeHandler_;
  std::vector<id> tokens_;
  std::mutex mutex_;
};

}  // namespace

std::unique_ptr<VideoInputEnumerator> createUvcEnumerator() { return std::make_unique<UvcEnumerator>(); }

}  // namespace broadify::pgm
