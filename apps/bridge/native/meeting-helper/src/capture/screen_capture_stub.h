#pragma once

#include "capture/screen_capture_source.h"

#include <mutex>

namespace broadify::meeting {

class StubScreenCaptureSource final : public ScreenCaptureSource {
 public:
  ScreenCaptureCapabilities capabilities() const override;
  std::vector<ScreenSourceInfo> listSources() override;
  bool start(const std::string &sourceId,
             const ScreenCaptureStartOptions &options) override;
  bool presentPicker(const ScreenCaptureStartOptions &options) override;
  void stop() override;
  bool isRunning() const override;
  ScreenCaptureStatus status() const override;
  bool copyLatestFrame(VideoFrame &frame) override;
  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override;
  bool takeLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override;
  std::string lastError() const override;

  ScreenCaptureCapabilities capabilitiesOverride{
      false, false, false, "unsupported", "unsupported_os"};
  std::vector<std::string> knownSourceIds;
  int startCalls = 0;
  ScreenCaptureStartOptions lastStartOptions;
  int pickCalls = 0;
  bool lastStartReopened = false;

 private:
  mutable std::mutex mutex_;
  bool running_ = false;
  bool pickerPending_ = false;
  std::string sourceId_;
  std::string lastError_;
};

}  // namespace broadify::meeting
