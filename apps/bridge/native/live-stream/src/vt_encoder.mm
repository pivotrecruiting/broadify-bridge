#import <CoreMedia/CoreMedia.h>
#import <VideoToolbox/VideoToolbox.h>

#include "live_stream/video_encoder.h"

#include <atomic>
#include <mutex>

namespace broadify::live {
namespace {

/**
 * VideoToolbox H.264, hardware only, real-time: no frame reordering (no
 * B-frames), 2 s GOP, average + hard data-rate limit, keyframe on demand
 * (PLI / new viewer / format change). Output converts AVCC to Annex B with the
 * parameter sets prepended on keyframes so late joiners decode immediately.
 */
class VideoToolboxEncoder final : public VideoEncoder {
 public:
  ~VideoToolboxEncoder() override { teardown(); }

  bool configure(const EncodeTarget &target, std::string &errorCode, std::string &error) override {
    std::lock_guard<std::mutex> lock(mutex_);
    teardownLocked();
    target_ = target;
    NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : @YES};
    NSDictionary *sourceAttrs = @{
      (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      (__bridge NSString *)kCVPixelBufferWidthKey : @(target.width),
      (__bridge NSString *)kCVPixelBufferHeightKey : @(target.height),
    };
    VTCompressionSessionRef session = nullptr;
    const OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault, static_cast<int32_t>(target.width),
                                                       static_cast<int32_t>(target.height), kCMVideoCodecType_H264,
                                                       (__bridge CFDictionaryRef)spec, (__bridge CFDictionaryRef)sourceAttrs,
                                                       nullptr, &VideoToolboxEncoder::outputCallback, this, &session);
    if (status != noErr || session == nullptr) {
      errorCode = "encoder_unavailable";
      error = "No hardware H.264 encoder is available (VTCompressionSessionCreate " + std::to_string(status) + ").";
      return false;
    }
    session_ = session;
    const double fps = target.fpsDen > 0 ? static_cast<double>(target.fpsNum) / target.fpsDen : 30.0;
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel);
    set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC);
    setNumber(kVTCompressionPropertyKey_ExpectedFrameRate, fps);
    setNumber(kVTCompressionPropertyKey_MaxKeyFrameInterval, static_cast<double>(std::max<uint32_t>(1, static_cast<uint32_t>(fps * target.gopSeconds))));
    setNumber(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, static_cast<double>(target.gopSeconds));
    if (@available(macOS 14.0, *)) {
      set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue);
    }
    applyBitrateLocked(target.bitrateKbps, target.maxBitrateKbps);
    VTCompressionSessionPrepareToEncodeFrames(session_);
    forceKeyframe_.store(true);
    return true;
  }

  bool encode(const CapturedFrame &frame, bool forceKeyframe) override {
    VTCompressionSessionRef session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = session_;
    }
    if (session == nullptr || frame.pixelBuffer == nullptr) {
      return false;
    }
    const bool key = forceKeyframe || forceKeyframe_.exchange(false);
    NSDictionary *frameProps = key ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES} : nil;
    const CMTime pts = CMTimeMake(static_cast<int64_t>(frame.captureNs / 1000), 1000000);
    const OSStatus status = VTCompressionSessionEncodeFrame(session, frame.pixelBuffer, pts, kCMTimeInvalid,
                                                            (__bridge CFDictionaryRef)frameProps,
                                                            reinterpret_cast<void *>(frame.captureNs), nullptr);
    return status == noErr;
  }

  void setBitrate(uint32_t bitrateKbps, uint32_t maxBitrateKbps) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (session_ != nullptr) {
      applyBitrateLocked(bitrateKbps, maxBitrateKbps);
    }
  }

  void requestKeyframe() override { forceKeyframe_.store(true); }

  void flush() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (session_ != nullptr) {
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
    }
  }

  EncoderInfo info() const override { return {"videotoolbox", true}; }

 private:
  void set(CFStringRef key, CFTypeRef value) { VTSessionSetProperty(session_, key, value); }
  void setNumber(CFStringRef key, double value) {
    CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberDoubleType, &value);
    VTSessionSetProperty(session_, key, number);
    CFRelease(number);
  }

  void applyBitrateLocked(uint32_t bitrateKbps, uint32_t maxBitrateKbps) {
    setNumber(kVTCompressionPropertyKey_AverageBitRate, static_cast<double>(bitrateKbps) * 1000.0);
    // Hard cap per second: max bytes over 1 s window.
    const double maxBytesPerSecond = static_cast<double>(std::max(maxBitrateKbps, bitrateKbps)) * 1000.0 / 8.0;
    NSArray *limits = @[ @(maxBytesPerSecond), @(1.0) ];
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_DataRateLimits, (__bridge CFArrayRef)limits);
  }

  void teardown() {
    std::lock_guard<std::mutex> lock(mutex_);
    teardownLocked();
  }

  void teardownLocked() {
    if (session_ != nullptr) {
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
    }
  }

  static void outputCallback(void *refcon, void *sourceFrameRefCon, OSStatus status, VTEncodeInfoFlags infoFlags,
                             CMSampleBufferRef sample) {
    auto *self = static_cast<VideoToolboxEncoder *>(refcon);
    if (self == nullptr || status != noErr || sample == nullptr || (infoFlags & kVTEncodeInfo_FrameDropped)) {
      return;
    }
    self->emit(sample, reinterpret_cast<uint64_t>(sourceFrameRefCon));
  }

  void emit(CMSampleBufferRef sample, uint64_t captureNs) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    if (block == nullptr) {
      return;
    }
    bool keyframe = true;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (attachments != nullptr && CFArrayGetCount(attachments) > 0) {
      CFDictionaryRef attachment = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
      keyframe = !CFDictionaryContainsKey(attachment, kCMSampleAttachmentKey_NotSync);
    }
    size_t length = 0;
    char *data = nullptr;
    if (CMBlockBufferGetDataPointer(block, 0, nullptr, &length, &data) != kCMBlockBufferNoErr || data == nullptr) {
      return;
    }
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    int nalLengthSize = 4;
    H264ParameterSets sets;
    if (format != nullptr) {
      const uint8_t *sps = nullptr;
      const uint8_t *pps = nullptr;
      size_t spsSize = 0;
      size_t ppsSize = 0;
      if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &sps, &spsSize, nullptr, &nalLengthSize) == noErr &&
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 1, &pps, &ppsSize, nullptr, nullptr) == noErr) {
        sets.sps.assign(sps, sps + spsSize);
        sets.pps.assign(pps, pps + ppsSize);
      }
    }
    EncodedAccessUnit unit;
    unit.keyframe = keyframe;
    unit.captureNs = captureNs;
    if (!avccToAnnexB(reinterpret_cast<const uint8_t *>(data), length, static_cast<size_t>(nalLengthSize), unit.annexB)) {
      return;
    }
    if (keyframe) {
      prependParameterSets(sets, unit.annexB);
    }
    CFRetain(sample);
    unit.sample = sample;
    if (onAccessUnit) {
      onAccessUnit(std::move(unit));
    } else {
      CFRelease(unit.sample);
    }
  }

  VTCompressionSessionRef session_ = nullptr;
  EncodeTarget target_;
  std::atomic<bool> forceKeyframe_{false};
  std::mutex mutex_;
};

}  // namespace

std::unique_ptr<VideoEncoder> createVideoToolboxEncoder() { return std::make_unique<VideoToolboxEncoder>(); }

}  // namespace broadify::live
