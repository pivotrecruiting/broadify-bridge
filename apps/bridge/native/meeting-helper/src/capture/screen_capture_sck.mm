#include "capture/screen_capture_source.h"

#if defined(__APPLE__)

#include "capture/guarded_frame_slot.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"

#import <Accelerate/Accelerate.h>
#import <AppKit/AppKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace broadify::meeting {
class ScreenCaptureKitSource;
}

@interface BroadifyScreenStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
- (instancetype)initWithOwner:(broadify::meeting::ScreenCaptureKitSource *)owner;
@end

API_AVAILABLE(macos(14.0))
@interface BroadifyContentSharingPickerObserver : NSObject <SCContentSharingPickerObserver>
- (instancetype)initWithOwner:(broadify::meeting::ScreenCaptureKitSource *)owner;
@end

namespace broadify::meeting {
namespace {

std::string nsStringToStd(NSString *value) {
  return value != nil ? (value.UTF8String != nullptr ? value.UTF8String : "") : "";
}

std::string nsErrorToString(NSError *error) {
  if (error == nil) {
    return "";
  }
  std::ostringstream out;
  out << nsStringToStd(error.domain) << "/" << error.code << ": "
      << nsStringToStd(error.localizedDescription);
  return out.str();
}

void emitScreenStoppedEvent(const std::string &reason, const std::string &code) {
  std::ostringstream event;
  event << "{\"type\":\"" << kScreenCaptureStoppedEvent
        << "\",\"reason\":\"" << jsonEscape(reason) << "\"";
  if (!code.empty()) {
    event << ",\"code\":\"" << jsonEscape(code) << "\"";
  }
  event << "}";
  emitHelperEvent(event.str());
}

void emitScreenPickerEvent(const std::string &pickerEvent, const std::string &code) {
  std::ostringstream event;
  event << "{\"type\":\"" << kScreenCapturePickerEvent
        << "\",\"event\":\"" << jsonEscape(pickerEvent) << "\"";
  if (!code.empty()) {
    // Keep `code` a JSON string like every other helper event so the bridge
    // can treat it uniformly (it is an NSError code rendered as text).
    event << ",\"code\":\"" << jsonEscape(code) << "\"";
  }
  event << "}";
  emitHelperEvent(event.str());
}

void emitScreenErrorEvent(const std::string &code, const std::string &message) {
  std::ostringstream event;
  event << "{\"type\":\"" << kScreenCaptureErrorEvent
        << "\",\"code\":\"" << jsonEscape(code)
        << "\",\"message\":\"" << jsonEscape(message) << "\"}";
  emitHelperEvent(event.str());
}

std::string kindFromFilter(SCContentFilter *filter) {
  if (@available(macOS 14.0, *)) {
    switch (filter.style) {
      case SCShareableContentStyleWindow:
        return "window";
      case SCShareableContentStyleDisplay:
        return "display";
      case SCShareableContentStyleApplication:
        return "application";
      case SCShareableContentStyleNone:
        break;
    }
  }
  return "display";
}

}  // namespace

class ScreenCaptureKitSource final : public ScreenCaptureSource {
 public:
  explicit ScreenCaptureKitSource(int parentPid) {
    (void)parentPid;
    @autoreleasepool {
      output_ = [[BroadifyScreenStreamOutput alloc] initWithOwner:this];
      sampleQueue_ = dispatch_queue_create("com.broadify.meeting.screen",
                                           DISPATCH_QUEUE_SERIAL);
      if (@available(macOS 14.0, *)) {
        pickerObserver_ = [[BroadifyContentSharingPickerObserver alloc]
            initWithOwner:this];
      }
    }
  }

  ~ScreenCaptureKitSource() override {
    stop();
  }

  ScreenCaptureCapabilities capabilities() const override {
    @autoreleasepool {
      if (@available(macOS 14.0, *)) {
        ScreenCaptureCapabilities capabilities;
        capabilities.supported = true;
        capabilities.systemPicker = true;
        capabilities.enumeration = false;
        capabilities.permissionStatus = "not_required";
        return capabilities;
      }
      ScreenCaptureCapabilities capabilities;
      capabilities.supported = false;
      capabilities.systemPicker = false;
      capabilities.enumeration = false;
      capabilities.permissionStatus = "unsupported";
      capabilities.unsupportedReason = "unsupported_os";
      return capabilities;
    }
  }

  std::vector<ScreenSourceInfo> listSources() override {
    std::lock_guard<std::mutex> lock(mutex_);
    lastError_.clear();
    return {};
  }

  bool start(const std::string &sourceId,
             const ScreenCaptureStartOptions &options) override {
    SCContentFilter *filter = buildFilterForSourceId(sourceId);
    if (filter == nil) {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "unsupported";
      return false;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      options_ = options;
      lastError_.clear();
    }
    startStreamWithFilter(filter);
    return true;
  }

  bool presentPicker(const ScreenCaptureStartOptions &options) override {
    @autoreleasepool {
      if (!capabilities().supported) {
        std::lock_guard<std::mutex> lock(mutex_);
        lastError_ = "unsupported_os";
        return false;
      }
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pickerPending_) {
          lastError_ = "picker_busy";
          return false;
        }
        pickerPending_ = true;
        options_ = options;
        lastError_.clear();
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
          if (@available(macOS 14.0, *)) {
            SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
            SCContentSharingPickerConfiguration *config =
                [[SCContentSharingPickerConfiguration alloc] init];
            config.allowedPickerModes = SCContentSharingPickerModeSingleDisplay |
                                        SCContentSharingPickerModeSingleWindow |
                                        SCContentSharingPickerModeSingleApplication;
            config.excludedBundleIDs = @[
              @"com.broadify.bridge",
              @"com.broadify.bridge.rc",
              @"com.broadify.bridge.meeting-helper",
            ];
            config.allowsChangingSelectedContent = YES;
            picker.defaultConfiguration = config;
            picker.maximumStreamCount = @1;
            if (!pickerObserverRegistered_ && pickerObserver_ != nil) {
              [picker addObserver:(id<SCContentSharingPickerObserver>)pickerObserver_];
              pickerObserverRegistered_ = true;
            }
            picker.active = YES;
            [picker present];
            // If the LSUIElement picker does not appear during manual testing,
            // activate NSApp here using activateIgnoringOtherApps:YES.
            emitScreenPickerEvent("presented", "");
          }
        }
      });
      return true;
    }
  }

  void stop() override {
    stopInternal(true, true);
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  ScreenCaptureStatus status() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    ScreenCaptureStatus status;
    status.running = running_;
    status.pickerPending = pickerPending_;
    status.kind = kind_;
    status.title = title_;
    status.appName = appName_;
    status.width = width_;
    status.height = height_;
    status.capturedFrames = capturedFrames_.load();
    return status;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    return frames_.copyLatest(frame);
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    return frames_.copyIfNew(lastTimestampNs, frame);
  }

  bool takeLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    return frames_.takeIfNew(lastTimestampNs, frame);
  }

  bool waitForFrameOrTimeout(
      uint64_t lastTimestampNs,
      std::chrono::steady_clock::time_point deadline) override {
    return frames_.waitForNewerThan(lastTimestampNs, deadline);
  }

  std::string lastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
  }

  std::string stickyLastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return stickyError_;
  }

  uint64_t stickyLastErrorAtMs() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return stickyErrorAtMs_;
  }

  void handleSampleBuffer(CMSampleBufferRef sampleBuffer) {
    @autoreleasepool {
      CFArrayRef attachments =
          CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
      if (attachments != nullptr && CFArrayGetCount(attachments) > 0) {
        CFDictionaryRef attachment = static_cast<CFDictionaryRef>(
            CFArrayGetValueAtIndex(attachments, 0));
        CFNumberRef statusNumber = attachment != nullptr
            ? static_cast<CFNumberRef>(
                  CFDictionaryGetValue(attachment, (__bridge const void *)SCStreamFrameInfoStatus))
            : nullptr;
        if (statusNumber != nullptr) {
          int statusValue = 0;
          if (CFNumberGetValue(statusNumber, kCFNumberIntType, &statusValue)) {
            const SCFrameStatus status =
                static_cast<SCFrameStatus>(statusValue);
            if (status != SCFrameStatusComplete &&
                status != SCFrameStatusStarted) {
              return;
            }
          }
        }
      }

      CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
      if (imageBuffer == nullptr) {
        return;
      }
      CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
      const size_t width = CVPixelBufferGetWidth(imageBuffer);
      const size_t height = CVPixelBufferGetHeight(imageBuffer);
      const size_t stride = CVPixelBufferGetBytesPerRow(imageBuffer);
      const auto *src =
          static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(imageBuffer));
      if (src == nullptr || width == 0u || height == 0u) {
        CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        return;
      }

      VideoFrame &frame = frames_.scratch();
      frame.width = static_cast<uint32_t>(width);
      frame.height = static_cast<uint32_t>(height);
      frame.timestampNs = nowNs();
      frame.captureQpc = 0;
      frame.rgba.resize(width * height * 4u);
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
          vImagePermuteChannels_ARGB8888(&sourceBuffer, &destinationBuffer,
                                         kBgraToRgba, kvImageNoFlags);
      CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
      if (permuteStatus != kvImageNoError) {
        return;
      }

      frames_.publish();
      ++capturedFrames_;
    }
  }

  void handleStreamStopped(NSError *error) {
    std::string code;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      running_ = false;
      pickerPending_ = false;
      stream_ = nil;
      filter_ = nil;
      config_ = nil;
      if (error != nil) {
        code = std::to_string(error.code);
        setStickyErrorLocked(nsErrorToString(error));
        lastError_ = "stream_stopped";
      }
    }
    emitScreenStoppedEvent("stream_stopped", code);
  }

  void handlePickerFilter(SCContentFilter *filter, SCStream *stream) {
    @autoreleasepool {
      if (filter == nil) {
        return;
      }
      if (stream == nil) {
        startStreamWithFilter(filter);
        return;
      }

      SCStream *activeStream = nil;
      ScreenCaptureStartOptions options;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        activeStream = stream_;
        options = options_;
      }
      if (activeStream == nil) {
        startStreamWithFilter(filter);
        return;
      }

      const std::string kind = kindFromFilter(filter);
      const CaptureSize size = sizeForFilter(filter, options);
      SCStreamConfiguration *config = buildConfiguration(size, options);
      [activeStream updateContentFilter:filter completionHandler:^(NSError *error) {
        if (error != nil) {
          handlePickerStartFailed(error);
        }
      }];
      [activeStream updateConfiguration:config completionHandler:^(NSError *error) {
        if (error != nil) {
          handlePickerStartFailed(error);
        }
      }];
      {
        std::lock_guard<std::mutex> lock(mutex_);
        filter_ = filter;
        config_ = config;
        kind_ = kind;
        title_.clear();
        appName_.clear();
        width_ = size.width;
        height_ = size.height;
        pickerPending_ = false;
      }
      std::ostringstream event;
      event << "{\"type\":\"" << kScreenCaptureSourceChangedEvent
            << "\",\"kind\":\"" << jsonEscape(kind)
            << "\",\"width\":" << size.width
            << ",\"height\":" << size.height << "}";
      emitHelperEvent(event.str());
    }
  }

  void handlePickerCancelled(SCStream *stream) {
    (void)stream;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pickerPending_ = false;
    }
    emitScreenPickerEvent("cancelled", "");
  }

  void handlePickerStartFailed(NSError *error) {
    const std::string message = nsErrorToString(error);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pickerPending_ = false;
      lastError_ = "picker_failed";
      setStickyErrorLocked(message);
    }
    emitScreenPickerEvent("failed", error != nil ? std::to_string(error.code) : "");
  }

 private:
  void stopInternal(bool emitEvent, bool deactivatePicker) {
    @autoreleasepool {
      SCStream *stream = nil;
      BroadifyScreenStreamOutput *output = nil;
      bool shouldEmit = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        stream = stream_;
        output = output_;
        shouldEmit = running_ || pickerPending_ || stream_ != nil;
        pickerPending_ = false;
        running_ = false;
        stream_ = nil;
        filter_ = nil;
        config_ = nil;
        kind_.clear();
        title_.clear();
        appName_.clear();
        width_ = 0;
        height_ = 0;
      }

      if (stream != nil) {
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        [stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
          dispatch_semaphore_signal(semaphore);
        }];
        dispatch_time_t timeout =
            dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(NSEC_PER_SEC));
        dispatch_semaphore_wait(semaphore, timeout);
        [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:nil];
      }

      if (deactivatePicker) {
        void (^deactivateBlock)(void) = ^{
          @autoreleasepool {
            if (@available(macOS 14.0, *)) {
              SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
              picker.active = NO;
              if (pickerObserverRegistered_ && pickerObserver_ != nil) {
                [picker removeObserver:(id<SCContentSharingPickerObserver>)pickerObserver_];
                pickerObserverRegistered_ = false;
              }
            }
          }
        };
        if ([NSThread isMainThread]) {
          deactivateBlock();
        } else {
          dispatch_sync(dispatch_get_main_queue(), deactivateBlock);
        }
      }

      if (emitEvent && shouldEmit) {
        emitScreenStoppedEvent("user_stop", "");
      }
    }
  }

  CaptureSize sizeForFilter(SCContentFilter *filter,
                            const ScreenCaptureStartOptions &options) {
    uint32_t srcW = options.maxWidth;
    uint32_t srcH = options.maxHeight;
    if (@available(macOS 14.0, *)) {
      const CGRect rect = filter.contentRect;
      const float scale = filter.pointPixelScale;
      const double scaledW = rect.size.width * scale;
      const double scaledH = rect.size.height * scale;
      if (scaledW > 0.0 && scaledH > 0.0) {
        srcW = static_cast<uint32_t>(scaledW);
        srcH = static_cast<uint32_t>(scaledH);
      }
    }
    CaptureSize size = clampScreenCaptureSize(srcW, srcH, options.maxWidth,
                                              options.maxHeight);
    if (size.width == 0u || size.height == 0u) {
      size.width = std::max(2u, options.maxWidth);
      size.height = std::max(2u, options.maxHeight);
    }
    return size;
  }

  SCContentFilter *buildFilterForSourceId(const std::string &sourceId) {
    (void)sourceId;
    // Stage 1 has no macOS enumeration path. A later TCC-backed path can build
    // an SCContentFilter through SCShareableContent here.
    return nil;
  }

  SCStreamConfiguration *buildConfiguration(
      const CaptureSize &size,
      const ScreenCaptureStartOptions &options) {
    SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
    config.width = size.width;
    config.height = size.height;
    config.pixelFormat = kCVPixelFormatType_32BGRA;
    config.minimumFrameInterval =
        CMTimeMake(1, static_cast<int32_t>(std::max(1u, options.fps)));
    config.queueDepth = 5;
    config.showsCursor = options.includeCursor;
    config.scalesToFit = YES;
    config.capturesAudio = NO;
    if (@available(macOS 14.0, *)) {
      config.preservesAspectRatio = YES;
      config.captureResolution = SCCaptureResolutionAutomatic;
      config.streamName = @"Broadify Meeting";
    }
    return config;
  }

  void startStreamWithFilter(SCContentFilter *filter) {
    @autoreleasepool {
      stopInternal(false, false);
      ScreenCaptureStartOptions options;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        options = options_;
      }

      const std::string kind = kindFromFilter(filter);
      const CaptureSize size = sizeForFilter(filter, options);
      SCStreamConfiguration *config = buildConfiguration(size, options);
      SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                            configuration:config
                                                 delegate:output_];
      NSError *addOutputError = nil;
      if (![stream addStreamOutput:output_
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:sampleQueue_
                             error:&addOutputError]) {
        const std::string message = nsErrorToString(addOutputError);
        {
          std::lock_guard<std::mutex> lock(mutex_);
          pickerPending_ = false;
          lastError_ = "start_failed";
          setStickyErrorLocked(message);
        }
        emitScreenErrorEvent("screen_start_failed", message);
        return;
      }

      {
        std::lock_guard<std::mutex> lock(mutex_);
        stream_ = stream;
        filter_ = filter;
        config_ = config;
        kind_ = kind;
        title_.clear();
        appName_.clear();
        width_ = size.width;
        height_ = size.height;
      }

      [stream startCaptureWithCompletionHandler:^(NSError *error) {
        if (error != nil) {
          const std::string message = nsErrorToString(error);
          {
            std::lock_guard<std::mutex> lock(mutex_);
            running_ = false;
            pickerPending_ = false;
            lastError_ = "start_failed";
            setStickyErrorLocked(message);
          }
          emitScreenErrorEvent("screen_start_failed", message);
          return;
        }

        std::string startedKind;
        uint32_t startedWidth = 0;
        uint32_t startedHeight = 0;
        uint32_t startedFps = 0;
        {
          std::lock_guard<std::mutex> lock(mutex_);
          running_ = true;
          pickerPending_ = false;
          capturedFrames_ = 0;
          lastError_.clear();
          startedKind = kind_;
          startedWidth = width_;
          startedHeight = height_;
          startedFps = options_.fps;
        }
        std::ostringstream event;
        event << "{\"type\":\"" << kScreenCaptureStartedEvent
              << "\",\"kind\":\"" << jsonEscape(startedKind)
              << "\",\"width\":" << startedWidth
              << ",\"height\":" << startedHeight
              << ",\"fps\":" << startedFps << "}";
        emitHelperEvent(event.str());
      }];
    }
  }

  void setStickyErrorLocked(const std::string &error) {
    stickyError_ = error;
    stickyErrorAtMs_ = nowNs() / 1000000ull;
  }

  mutable std::mutex mutex_;
  GuardedFrameSlot frames_;
  SCStream *stream_ = nil;
  SCContentFilter *filter_ = nil;
  SCStreamConfiguration *config_ = nil;
  BroadifyScreenStreamOutput *output_ = nil;
  dispatch_queue_t sampleQueue_ = nil;
  id pickerObserver_ = nil;
  bool pickerObserverRegistered_ = false;
  bool running_ = false;
  bool pickerPending_ = false;
  ScreenCaptureStartOptions options_;
  std::string lastError_;
  std::string stickyError_;
  uint64_t stickyErrorAtMs_ = 0;
  std::string kind_;
  std::string title_;
  std::string appName_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  std::atomic<uint64_t> capturedFrames_{0};
};

std::unique_ptr<ScreenCaptureSource> createScreenCaptureSource(int parentPid) {
  return std::make_unique<ScreenCaptureKitSource>(parentPid);
}

}  // namespace broadify::meeting

@implementation BroadifyScreenStreamOutput {
  broadify::meeting::ScreenCaptureKitSource *_owner;
}

- (instancetype)initWithOwner:(broadify::meeting::ScreenCaptureKitSource *)owner {
  self = [super init];
  if (self) {
    _owner = owner;
  }
  return self;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type == SCStreamOutputTypeScreen && _owner != nullptr) {
    _owner->handleSampleBuffer(sampleBuffer);
  }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  if (_owner != nullptr) {
    _owner->handleStreamStopped(error);
  }
}

@end

@implementation BroadifyContentSharingPickerObserver {
  broadify::meeting::ScreenCaptureKitSource *_owner;
}

- (instancetype)initWithOwner:(broadify::meeting::ScreenCaptureKitSource *)owner {
  self = [super init];
  if (self) {
    _owner = owner;
  }
  return self;
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker
          didCancelForStream:(SCStream *)stream {
  (void)picker;
  if (_owner != nullptr) {
    _owner->handlePickerCancelled(stream);
  }
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker
         didUpdateWithFilter:(SCContentFilter *)filter
                   forStream:(SCStream *)stream {
  (void)picker;
  if (_owner != nullptr) {
    _owner->handlePickerFilter(filter, stream);
  }
}

- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
  if (_owner != nullptr) {
    _owner->handlePickerStartFailed(error);
  }
}

@end

#endif
