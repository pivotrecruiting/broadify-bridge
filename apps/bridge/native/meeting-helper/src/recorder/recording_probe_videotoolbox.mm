#include "recorder/recording_probe.h"

#if defined(__APPLE__)
#import <CoreFoundation/CoreFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <VideoToolbox/VideoToolbox.h>

#include <optional>
#include <utility>

namespace broadify::meeting {
namespace {

std::optional<RecordingCodec> recordingCodecForType(CMVideoCodecType type) {
  switch (type) {
    case kCMVideoCodecType_H264:
      return RecordingCodec::H264;
    case kCMVideoCodecType_HEVC:
      return RecordingCodec::Hevc;
    case kCMVideoCodecType_AppleProRes422LT:
      return RecordingCodec::ProRes422Lt;
    case kCMVideoCodecType_AppleProRes422:
      return RecordingCodec::ProRes422;
    case kCMVideoCodecType_AppleProRes422HQ:
      return RecordingCodec::ProRes422Hq;
    default:
      return std::nullopt;
  }
}

std::string stringFromCFString(CFStringRef value) {
  if (value == nullptr) {
    return {};
  }
  const CFIndex capacity =
      CFStringGetMaximumSizeForEncoding(CFStringGetLength(value),
                                        kCFStringEncodingUTF8) +
      1;
  std::string text(static_cast<size_t>(capacity), '\0');
  if (!CFStringGetCString(value, text.data(), capacity,
                          kCFStringEncodingUTF8)) {
    return {};
  }
  text.resize(std::char_traits<char>::length(text.c_str()));
  return text;
}

}  // namespace

// The VideoToolbox encoder list, reduced to the hardware-accelerated encoders
// of the recording codecs. The list is a static registry read: no compression
// session is created.
RecordingProbeResult probeRecordingEncoders() {
  RecordingProbeResult result;
  result.backend = "videotoolbox";
  CFArrayRef encoders = nullptr;
  if (VTCopyVideoEncoderList(nullptr, &encoders) != noErr ||
      encoders == nullptr) {
    return result;
  }
  result.ok = true;
  const CFIndex count = CFArrayGetCount(encoders);
  for (CFIndex index = 0; index < count; ++index) {
    const auto *entry = static_cast<CFDictionaryRef>(
        CFArrayGetValueAtIndex(encoders, index));
    if (entry == nullptr ||
        CFDictionaryGetValue(entry,
                             kVTVideoEncoderList_IsHardwareAccelerated) !=
            kCFBooleanTrue) {
      continue;
    }
    const auto *typeNumber = static_cast<CFNumberRef>(
        CFDictionaryGetValue(entry, kVTVideoEncoderList_CodecType));
    SInt32 type = 0;
    if (typeNumber == nullptr ||
        !CFNumberGetValue(typeNumber, kCFNumberSInt32Type, &type)) {
      continue;
    }
    const std::optional<RecordingCodec> codec =
        recordingCodecForType(static_cast<CMVideoCodecType>(type));
    if (!codec) {
      continue;
    }
    RecordingEncoderInfo info;
    info.codec = *codec;
    info.name = stringFromCFString(static_cast<CFStringRef>(
        CFDictionaryGetValue(entry, kVTVideoEncoderList_DisplayName)));
    result.encoders.push_back(std::move(info));
  }
  CFRelease(encoders);
  return result;
}

}  // namespace broadify::meeting
#endif
