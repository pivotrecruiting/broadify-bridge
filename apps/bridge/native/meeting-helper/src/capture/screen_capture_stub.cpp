#include "capture/screen_capture_stub.h"

#include <algorithm>

namespace broadify::meeting {

ScreenCaptureCapabilities StubScreenCaptureSource::capabilities() const {
  return capabilitiesOverride;
}

std::vector<ScreenSourceInfo> StubScreenCaptureSource::listSources() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!capabilitiesOverride.enumeration) {
    return {};
  }
  std::vector<ScreenSourceInfo> sources;
  sources.reserve(knownSourceIds.size());
  for (const std::string &sourceId : knownSourceIds) {
    ScreenSourceInfo source;
    source.sourceId = sourceId;
    source.kind = sourceId.rfind("window:", 0) == 0 ? "window" : "display";
    source.title = sourceId;
    source.width = lastStartOptions.maxWidth;
    source.height = lastStartOptions.maxHeight;
    source.primary = sources.empty();
    source.active = running_ && sourceId_ == sourceId;
    sources.push_back(source);
  }
  lastError_.clear();
  return sources;
}

bool StubScreenCaptureSource::start(const std::string &sourceId,
                                    const ScreenCaptureStartOptions &options) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++startCalls;
  lastStartOptions = options;
  lastStartReopened = false;
  if (!capabilitiesOverride.supported || !capabilitiesOverride.enumeration) {
    lastError_ = capabilitiesOverride.unsupportedReason.empty()
        ? "unsupported"
        : capabilitiesOverride.unsupportedReason;
    return false;
  }
  if (std::find(knownSourceIds.begin(), knownSourceIds.end(), sourceId) ==
      knownSourceIds.end()) {
    lastError_ = "source_not_found";
    return false;
  }
  lastStartReopened = running_ && sourceId_ != sourceId;
  running_ = true;
  sourceId_ = sourceId;
  pickerPending_ = false;
  lastError_.clear();
  return true;
}

bool StubScreenCaptureSource::presentPicker(
    const ScreenCaptureStartOptions &options) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++pickCalls;
  lastStartOptions = options;
  if (!capabilitiesOverride.systemPicker) {
    lastError_ = capabilitiesOverride.unsupportedReason.empty()
        ? "unsupported"
        : capabilitiesOverride.unsupportedReason;
    return false;
  }
  if (pickerPending_) {
    lastError_ = "picker_busy";
    return false;
  }
  pickerPending_ = true;
  lastError_.clear();
  return true;
}

void StubScreenCaptureSource::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  running_ = false;
  pickerPending_ = false;
  sourceId_.clear();
  lastStartReopened = false;
}

bool StubScreenCaptureSource::isRunning() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return running_;
}

ScreenCaptureStatus StubScreenCaptureSource::status() const {
  std::lock_guard<std::mutex> lock(mutex_);
  ScreenCaptureStatus status;
  status.running = running_;
  status.pickerPending = pickerPending_;
  status.sourceId = sourceId_;
  status.kind = sourceId_.rfind("window:", 0) == 0 ? "window" :
      (sourceId_.empty() ? "" : "display");
  status.title = sourceId_;
  status.width = running_ ? lastStartOptions.maxWidth : 0u;
  status.height = running_ ? lastStartOptions.maxHeight : 0u;
  return status;
}

bool StubScreenCaptureSource::copyLatestFrame(VideoFrame &) {
  return false;
}

bool StubScreenCaptureSource::copyLatestFrameIfNew(uint64_t, VideoFrame &) {
  return false;
}

bool StubScreenCaptureSource::takeLatestFrameIfNew(uint64_t, VideoFrame &) {
  return false;
}

std::string StubScreenCaptureSource::lastError() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return lastError_;
}

#if !defined(BROADIFY_HAS_SCREEN_CAPTURE_BACKEND)
std::unique_ptr<ScreenCaptureSource> createScreenCaptureSource(int parentPid) {
  (void)parentPid;
  return std::make_unique<StubScreenCaptureSource>();
}
#endif

}  // namespace broadify::meeting
