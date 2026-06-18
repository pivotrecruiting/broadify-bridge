#include "capture/camera_source.h"

#if !defined(__APPLE__)

#include "util/json_utils.h"

#include <mutex>

namespace broadify::meeting {
namespace {

class StubCameraSource final : public CameraSource {
 public:
  std::vector<CameraInfo> listCameras() override {
    return {};
  }

  bool selectCamera(int cameraIndex) override {
    selectedIndex_ = cameraIndex;
    return true;
  }

  bool start(int cameraIndex, uint32_t, uint32_t, uint32_t) override {
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = true;
    selectedIndex_ = cameraIndex >= 0 ? cameraIndex : selectedIndex_;
    return true;
  }

  void stop() override {
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  int activeCameraIndex() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_ ? selectedIndex_ : -1;
  }

  bool copyLatestFrame(VideoFrame &) override {
    return false;
  }

  std::string lastError() const override {
    return "Native camera capture is not implemented on this platform yet.";
  }

  std::string cameraPermissionStatus() const override {
    return "unsupported";
  }

 private:
  mutable std::mutex mutex_;
  bool running_ = false;
  int selectedIndex_ = 0;
};

}  // namespace

std::unique_ptr<CameraSource> createCameraSource() {
  return std::make_unique<StubCameraSource>();
}

}  // namespace broadify::meeting

#endif
