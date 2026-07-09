#pragma once

#include <cstdint>
#include <map>
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

  // --- Multi-camera (Conference) ---------------------------------------------
  // Open several cameras at once and switch the program feed between them with
  // no device reopen (seamless cut) or read a specific one for picture-in-
  // picture. Backends without multi-camera support fall back to the single
  // active camera via these default implementations, so meeting and the stub
  // keep working unchanged.

  // Opens every listed camera simultaneously; the first becomes the program.
  virtual bool startSet(const std::vector<int> &cameraIndices, uint32_t width,
                        uint32_t height, uint32_t fps) {
    return !cameraIndices.empty() &&
           start(cameraIndices.front(), width, height, fps);
  }

  // The cameras currently open (program + any additional ones).
  virtual std::vector<int> activeCameraSet() const {
    const int index = activeCameraIndex();
    return index >= 0 ? std::vector<int>{index} : std::vector<int>{};
  }

  // Switches which open camera feeds the program (copyLatestFrame). Seamless
  // when the camera is already open; falls back to selectCamera otherwise.
  virtual bool setProgramCamera(int cameraIndex) {
    return selectCamera(cameraIndex);
  }

  // Reads the newest frame of a specific open camera (for PiP/preview).
  virtual bool copyLatestFrameFrom(int cameraIndex, uint64_t lastTimestampNs,
                                   VideoFrame &frame) {
    if (cameraIndex != activeCameraIndex()) {
      return false;
    }
    return copyLatestFrameIfNew(lastTimestampNs, frame);
  }

  // --- Auto-director (V3) ----------------------------------------------------
  // Recent audio level (0..1, smoothed RMS) of each open camera's paired
  // microphone, keyed by camera index. Empty when audio capture is unsupported.
  // The auto-director cuts the program to the loudest speaker.
  virtual std::map<int, float> cameraAudioLevels() const { return {}; }
};

std::unique_ptr<CameraSource> createCameraSource();
std::string camerasToJson(const std::vector<CameraInfo> &cameras);
std::string cameraToJson(const CameraInfo &camera);

}  // namespace broadify::meeting
