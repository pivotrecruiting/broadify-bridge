#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>
#endif

namespace broadify::pgm {

/** A captured frame in its native pixel format; the buffer is retained for the callback's duration only. */
struct CapturedFrame {
#if defined(__APPLE__)
  CVPixelBufferRef pixelBuffer = nullptr;
#endif
  uint32_t width = 0;
  uint32_t height = 0;
  std::string pixelFormat;  // "nv12" | "uyvy" | "yuy2" | "bgra"
  uint64_t captureNs = 0;   // host clock (mach_absolute_time based), monotonic
};

using FrameSink = std::function<void(const CapturedFrame &frame)>;

struct VideoInputInfo {
  std::string id;          // "uvc:<stable_key>"
  std::string kind;        // "uvc" | "decklink"
  std::string displayName;
  std::string deviceId;    // backend id (AVCaptureDevice uniqueID)
  std::string stableKey;
  bool available = true;
  bool inUse = false;
};

class VideoSource {
 public:
  virtual ~VideoSource() = default;
  /** Starts delivering frames; returns false with `error` and `errorCode` on failure. */
  virtual bool start(FrameSink sink, std::string &errorCode, std::string &error) = 0;
  virtual void stop() = 0;
  virtual bool isRunning() const = 0;
};

class VideoInputEnumerator {
 public:
  virtual ~VideoInputEnumerator() = default;
  virtual std::vector<VideoInputInfo> list() = 0;
  /** Device arrived/removed; called on an arbitrary thread. */
  virtual void setChangeHandler(std::function<void()> handler) = 0;
  /** "authorized" | "denied" | "restricted" | "not_determined"; may prompt the user (blocking). */
  virtual std::string ensureCameraAuthorization() = 0;
  virtual std::unique_ptr<VideoSource> open(const std::string &stableKey) = 0;
};

#if defined(__APPLE__)
std::unique_ptr<VideoInputEnumerator> createUvcEnumerator();
std::unique_ptr<VideoSource> createSyntheticSource(uint32_t width, uint32_t height, double fps);
#endif

}  // namespace broadify::pgm
