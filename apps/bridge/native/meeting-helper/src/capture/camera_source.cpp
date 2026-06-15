#include "capture/camera_source.h"

#include "util/json_utils.h"

#include <sstream>

namespace broadify::meeting {

std::string cameraToJson(const CameraInfo &camera) {
  std::ostringstream out;
  out << "{\"camera_index\":" << camera.cameraIndex
      << ",\"label\":\"" << jsonEscape(camera.label)
      << "\",\"camera_id\":\"" << jsonEscape(camera.cameraId)
      << "\",\"display_name\":\"" << jsonEscape(camera.displayName)
      << "\",\"stable_key\":\"" << jsonEscape(camera.stableKey)
      << "\",\"backend\":\"" << jsonEscape(camera.backend)
      << "\",\"device_name\":\"" << jsonEscape(camera.deviceName)
      << "\",\"is_builtin_camera_candidate\":" << (camera.builtinCandidate ? "true" : "false")
      << ",\"is_virtual_camera_candidate\":" << (camera.virtualCandidate ? "true" : "false")
      << ",\"is_continuity_camera_candidate\":" << (camera.continuityCandidate ? "true" : "false")
      << ",\"available\":" << (camera.available ? "true" : "false")
      << ",\"active\":" << (camera.active ? "true" : "false") << "}";
  return out.str();
}

std::string camerasToJson(const std::vector<CameraInfo> &cameras) {
  std::ostringstream out;
  out << "[";
  for (size_t i = 0; i < cameras.size(); ++i) {
    if (i > 0) {
      out << ",";
    }
    out << cameraToJson(cameras[i]);
  }
  out << "]";
  return out.str();
}

}  // namespace broadify::meeting
