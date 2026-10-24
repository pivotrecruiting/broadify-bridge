#pragma once

#include "live_stream/video_frame.h"

#if defined(__APPLE__)
#include <CoreMedia/CoreMedia.h>
#endif
#include "live_stream/bitrate_ladder.h"
#include "live_stream/h264_annexb.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace broadify::live {

/** One encoded H.264 access unit in Annex B (SPS/PPS prepended on keyframes). */
struct EncodedAccessUnit {
  std::vector<uint8_t> annexB;
  bool keyframe = false;
  uint64_t captureNs = 0;
#if defined(__APPLE__)
  /** The encoder's own sample (AVCC) for passthrough recording; retained, released by the receiver. */
  CMSampleBufferRef sample = nullptr;
#endif
};

struct EncoderInfo {
  std::string backend;  // "videotoolbox" | "mediafoundation"
  bool hardware = false;
};

/**
 * Hardware H.264 encoder abstraction. `encode` is called on the capture thread
 * and must not block; `onAccessUnit` fires on the encoder's thread. No software
 * fallback: `configure` fails with `encoder_unavailable` when no hardware
 * encoder exists (surfaced to the bridge, never hidden).
 */
class VideoEncoder {
 public:
  virtual ~VideoEncoder() = default;
  virtual bool configure(const EncodeTarget &target, std::string &errorCode, std::string &error) = 0;
  virtual bool encode(const CapturedFrame &frame, bool forceKeyframe) = 0;
  virtual void setBitrate(uint32_t bitrateKbps, uint32_t maxBitrateKbps) = 0;
  virtual void requestKeyframe() = 0;
  virtual void flush() = 0;
  virtual EncoderInfo info() const = 0;
  std::function<void(EncodedAccessUnit &&)> onAccessUnit;
};

#if defined(__APPLE__)
std::unique_ptr<VideoEncoder> createVideoToolboxEncoder();
#endif

}  // namespace broadify::live
