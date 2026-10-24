#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "audio/audio_source.h"

#include <mach/mach_time.h>
#include <mutex>
#include <vector>

@interface BroadifyPgmAudioDelegate : NSObject <AVCaptureAudioDataOutputSampleBufferDelegate>
@property(nonatomic, assign) std::function<void(CMSampleBufferRef)> *handler;
@end

@implementation BroadifyPgmAudioDelegate
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

uint64_t hostNowNs() {
  static mach_timebase_info_data_t info = {0, 0};
  if (info.denom == 0) {
    mach_timebase_info(&info);
  }
  return mach_absolute_time() * info.numer / info.denom;
}

AVCaptureDevice *findPairedAudioDevice(const std::string &videoDisplayName) {
  NSMutableArray<AVCaptureDeviceType> *types = [NSMutableArray arrayWithObject:AVCaptureDeviceTypeBuiltInMicrophone];
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
                                                             mediaType:AVMediaTypeAudio
                                                              position:AVCaptureDevicePositionUnspecified];
  NSString *wanted = [[NSString stringWithUTF8String:videoDisplayName.c_str()] lowercaseString];
  for (AVCaptureDevice *device in session.devices) {
    NSString *name = [device.localizedName lowercaseString];
    if ([name isEqualToString:wanted] || ([wanted length] >= 4 && [name containsString:wanted]) ||
        ([name length] >= 4 && [wanted containsString:name])) {
      return device;
    }
  }
  return nil;
}

class AvFoundationAudioSource final : public AudioSource {
 public:
  explicit AvFoundationAudioSource(AVCaptureDevice *device) : device_(device) {}
  ~AvFoundationAudioSource() override { stop(); }

  bool start(AudioSink sink, std::string &errorCode, std::string &error) override {
    @autoreleasepool {
      std::lock_guard<std::mutex> lock(mutex_);
      if (session_ != nil) {
        return true;
      }
      sink_ = std::move(sink);
      NSError *inputError = nil;
      AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device_ error:&inputError];
      if (input == nil) {
        errorCode = "device_in_use";
        error = inputError != nil ? [[inputError localizedDescription] UTF8String] : "Could not open the audio input.";
        return false;
      }
      AVCaptureSession *session = [[AVCaptureSession alloc] init];
      if (![session canAddInput:input]) {
        errorCode = "device_in_use";
        error = "Audio input cannot be added to the capture session.";
        return false;
      }
      [session addInput:input];
      AVCaptureAudioDataOutput *output = [[AVCaptureAudioDataOutput alloc] init];
      output.audioSettings = @{
        AVFormatIDKey : @(kAudioFormatLinearPCM),
        AVSampleRateKey : @48000.0,
        AVNumberOfChannelsKey : @2,
        AVLinearPCMBitDepthKey : @32,
        AVLinearPCMIsFloatKey : @YES,
        AVLinearPCMIsNonInterleaved : @NO,
      };
      if (![session canAddOutput:output]) {
        errorCode = "unsupported_format";
        error = "Audio output cannot be added to the capture session.";
        return false;
      }
      [session addOutput:output];
      handler_ = [this](CMSampleBufferRef sample) { deliver(sample); };
      delegate_ = [[BroadifyPgmAudioDelegate alloc] init];
      delegate_.handler = &handler_;
      queue_ = dispatch_queue_create("com.broadify.pgm.audio", DISPATCH_QUEUE_SERIAL);
      [output setSampleBufferDelegate:delegate_ queue:queue_];
      [session startRunning];
      session_ = session;
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
      output_ = nil;
      delegate_ = nil;
      queue_ = nil;
      sink_ = nullptr;
    }
  }

 private:
  void deliver(CMSampleBufferRef sample) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    if (block == nullptr) {
      return;
    }
    size_t length = 0;
    char *data = nullptr;
    if (CMBlockBufferGetDataPointer(block, 0, nullptr, &length, &data) != kCMBlockBufferNoErr || data == nullptr) {
      return;
    }
    AudioSink sink;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      sink = sink_;
    }
    if (!sink) {
      return;
    }
    AudioChunk chunk;
    chunk.samples = reinterpret_cast<const float *>(data);
    chunk.frames = static_cast<uint32_t>(length / (sizeof(float) * 2));
    const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
    chunk.captureNs = CMTIME_IS_VALID(pts) ? static_cast<uint64_t>(CMTimeGetSeconds(pts) * 1e9) : hostNowNs();
    sink(chunk);
  }

  AVCaptureDevice *device_ = nil;
  AVCaptureSession *session_ = nil;
  AVCaptureAudioDataOutput *output_ = nil;
  BroadifyPgmAudioDelegate *delegate_ = nil;
  dispatch_queue_t queue_ = nil;
  std::function<void(CMSampleBufferRef)> handler_;
  AudioSink sink_;
  std::mutex mutex_;
};

}  // namespace

std::unique_ptr<AudioSource> createPairedAudioSource(const std::string &videoDisplayName) {
  @autoreleasepool {
    AVCaptureDevice *device = findPairedAudioDevice(videoDisplayName);
    if (device == nil) {
      return nullptr;
    }
    return std::make_unique<AvFoundationAudioSource>(device);
  }
}

}  // namespace broadify::pgm
