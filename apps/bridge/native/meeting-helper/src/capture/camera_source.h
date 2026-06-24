#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace broadify::meeting {

struct CameraInfo {
  int cameraIndex = 0;
  std::string label;
  std::string cameraId;
  std::string displayName;
  std::string stableKey;
  std::string backend;
  std::string deviceName;
  bool builtinCandidate = false;
  bool virtualCandidate = false;
  bool continuityCandidate = false;
  bool available = true;
  bool active = false;
};

struct VideoFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t timestampNs = 0;
  std::vector<uint8_t> rgba;
};

class CameraSource {
 public:
  virtual ~CameraSource() = default;

  virtual std::vector<CameraInfo> listCameras() = 0;
  virtual bool selectCamera(int cameraIndex) = 0;
  virtual bool start(int cameraIndex, uint32_t width, uint32_t height, uint32_t fps) = 0;
  virtual void stop() = 0;
  virtual bool isRunning() const = 0;
  virtual int activeCameraIndex() const = 0;
  virtual bool copyLatestFrame(VideoFrame &frame) = 0;
  virtual bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) {
    if (!copyLatestFrame(frame) || frame.timestampNs == lastTimestampNs) {
      return false;
    }
    return true;
  }
  virtual std::string lastError() const = 0;
  virtual std::string cameraPermissionStatus() const = 0;
  virtual std::string requestCameraPermission() = 0;
};

std::unique_ptr<CameraSource> createCameraSource();
std::string camerasToJson(const std::vector<CameraInfo> &cameras);
std::string cameraToJson(const CameraInfo &camera);

}  // namespace broadify::meeting
