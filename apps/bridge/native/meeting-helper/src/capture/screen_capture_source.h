#pragma once

#include "capture/camera_source.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace broadify::meeting {

inline constexpr const char *kScreenCaptureStartedEvent = "screen_capture_started";
inline constexpr const char *kScreenCaptureStoppedEvent = "screen_capture_stopped";
inline constexpr const char *kScreenCaptureSourceChangedEvent = "screen_capture_source_changed";
inline constexpr const char *kScreenCapturePickerEvent = "screen_capture_picker";
inline constexpr const char *kScreenCaptureErrorEvent = "screen_capture_error";

struct ScreenSourceInfo {
  std::string sourceId;
  std::string kind;
  std::string title;
  std::string appName;
  uint32_t width = 0;
  uint32_t height = 0;
  bool primary = false;
  bool active = false;
};

struct ScreenCaptureCapabilities {
  bool supported = false;
  bool systemPicker = false;
  bool enumeration = false;
  std::string permissionStatus = "unsupported";
  std::string unsupportedReason;
};

struct ScreenCaptureStartOptions {
  uint32_t maxWidth = 1920;
  uint32_t maxHeight = 1080;
  uint32_t fps = 30;
  bool includeCursor = true;
};

struct ScreenCaptureStatus {
  bool running = false;
  bool pickerPending = false;
  std::string sourceId;
  std::string kind;
  std::string title;
  std::string appName;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t capturedFrames = 0;
};

struct CaptureSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

class ScreenCaptureSource {
 public:
  virtual ~ScreenCaptureSource() = default;

  virtual ScreenCaptureCapabilities capabilities() const = 0;
  virtual std::vector<ScreenSourceInfo> listSources() = 0;
  virtual bool start(const std::string &sourceId,
                     const ScreenCaptureStartOptions &options) = 0;
  virtual bool presentPicker(const ScreenCaptureStartOptions &options) = 0;
  virtual void stop() = 0;
  virtual bool isRunning() const = 0;
  virtual ScreenCaptureStatus status() const = 0;
  virtual bool copyLatestFrame(VideoFrame &frame) = 0;
  virtual bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) = 0;
  virtual bool takeLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) = 0;
  virtual bool waitForFrameOrTimeout(
      uint64_t lastTimestampNs,
      std::chrono::steady_clock::time_point deadline) {
    (void)lastTimestampNs;
    std::this_thread::sleep_until(deadline);
    return false;
  }
  virtual std::string lastError() const = 0;
  virtual std::string stickyLastError() const { return lastError(); }
  virtual uint64_t stickyLastErrorAtMs() const { return 0; }
  virtual std::string requestPermission() {
    return capabilities().permissionStatus;
  }
};

std::unique_ptr<ScreenCaptureSource> createScreenCaptureSource(int parentPid);
std::string screenSourceToJson(const ScreenSourceInfo &source);
std::string screenSourcesToJson(const std::vector<ScreenSourceInfo> &sources);
std::string screenCapabilitiesToJson(const ScreenCaptureCapabilities &capabilities);
CaptureSize clampScreenCaptureSize(uint32_t srcW, uint32_t srcH,
                                   uint32_t maxW, uint32_t maxH);
uint32_t selectCaptureMipLevel(uint32_t srcW, uint32_t srcH,
                               uint32_t minW, uint32_t minH);
bool parseScreenSourceId(const std::string &id, std::string &kind,
                         uint64_t &handle);

}  // namespace broadify::meeting
