#include "control/control_server.h"

#include "util/json_utils.h"

#include <algorithm>
#include <iostream>
#include <sstream>

#if defined(_WIN32)
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace broadify::meeting {
namespace {

std::string programSectionJson(const MeetingState &state, const std::string &section) {
  if (section == "speaker_layout") {
    return state.speakerLayout.rawJson;
  }
  if (section == "cornerbug") {
    return state.cornerbug.rawJson;
  }
  if (section == "media_layer") {
    return state.mediaLayer.rawJson;
  }
  if (section == "graphics") {
    return state.graphics.rawJson;
  }
  return "{\"enabled\":false}";
}

bool isProgramSection(const std::string &section) {
  return section == "speaker_layout" || section == "cornerbug" || section == "media_layer" || section == "graphics";
}

std::string metricNumber(double value) {
  return value >= 0.0 ? std::to_string(value) : "null";
}

std::string normalizedQualityMode(const std::string &qualityMode) {
  if (qualityMode == "fast" || qualityMode == "accurate") {
    return qualityMode;
  }
  return "balanced";
}

uint32_t clampedPixelRadius(int value, uint32_t maxValue) {
  return static_cast<uint32_t>(std::clamp(value, 0, static_cast<int>(maxValue)));
}

std::string keyerMetricsJson(const KeyerMetrics &metrics) {
  std::ostringstream result;
  result << "{\"camera_copy_ms\":" << metricNumber(metrics.cameraCopyMs)
         << ",\"tensor_ms\":" << metricNumber(metrics.tensorMs)
         << ",\"session_run_ms\":" << metricNumber(metrics.sessionRunMs)
         << ",\"mask_apply_ms\":" << metricNumber(metrics.maskApplyMs)
         << ",\"mask_dilate_ms\":" << metricNumber(metrics.maskDilateMs)
         << ",\"mask_postprocess_ms\":" << metricNumber(metrics.maskPostprocessMs)
         << ",\"mask_age_ms\":" << metricNumber(metrics.maskAgeMs)
         << ",\"program_frame_ms\":" << metricNumber(metrics.programFrameMs)
         << ",\"mjpeg_encode_ms\":" << metricNumber(metrics.mjpegEncodeMs)
         << ",\"mask_width\":" << metrics.maskWidth
         << ",\"mask_height\":" << metrics.maskHeight
         << ",\"dropped_frames\":" << metrics.droppedFrames << "}";
  return result.str();
}

void updateProgramSection(MeetingState &state, const std::string &section, const std::string &values) {
  const std::string safeValues = values.empty() ? "{\"enabled\":false}" : values;
  if (section == "speaker_layout") {
    state.speakerLayout.enabled = extractBoolField(safeValues, "enabled", state.speakerLayout.enabled);
    const std::string layout = extractStringField(safeValues, "layout");
    if (!layout.empty()) {
      state.speakerLayout.layout = layout;
    }
    state.speakerLayout.scale = extractDoubleField(safeValues, "scale", state.speakerLayout.scale);
    state.speakerLayout.rawJson = safeValues;
    return;
  }
  if (section == "cornerbug") {
    state.cornerbug.enabled = extractBoolField(safeValues, "enabled", state.cornerbug.enabled);
    state.cornerbug.x = extractDoubleField(safeValues, "x", state.cornerbug.x);
    state.cornerbug.y = extractDoubleField(safeValues, "y", state.cornerbug.y);
    state.cornerbug.size = extractDoubleField(safeValues, "size", state.cornerbug.size);
    state.cornerbug.rawJson = safeValues;
    return;
  }
  if (section == "media_layer") {
    state.mediaLayer.enabled = extractBoolField(safeValues, "enabled", state.mediaLayer.enabled);
    const std::string mode = extractStringField(safeValues, "mode");
    if (!mode.empty()) {
      state.mediaLayer.mode = mode;
    }
    state.mediaLayer.x = extractDoubleField(safeValues, "x", state.mediaLayer.x);
    state.mediaLayer.y = extractDoubleField(safeValues, "y", state.mediaLayer.y);
    state.mediaLayer.width = extractDoubleField(safeValues, "width", state.mediaLayer.width);
    state.mediaLayer.height = extractDoubleField(safeValues, "height", state.mediaLayer.height);
    state.mediaLayer.rotation = extractDoubleField(safeValues, "rotation", state.mediaLayer.rotation);
    state.mediaLayer.rawJson = safeValues;
    return;
  }
  if (section == "graphics") {
    state.graphics.enabled = extractBoolField(safeValues, "enabled", state.graphics.enabled);
    state.graphics.graphicId = extractStringField(safeValues, "graphic_id");
    state.graphics.templateName = extractStringField(safeValues, "template");
    state.graphics.source = extractStringField(safeValues, "source");
    state.graphics.handoffTarget = extractStringField(safeValues, "handoff_target");
    state.graphics.rawJson = safeValues;
  }
}

std::string handleRpc(const std::string &line, MeetingState &state, CameraSource &camera, const Options &options) {
  const std::string id = extractStringField(line, "id");
  const std::string method = extractStringField(line, "method");
  if (method.empty()) {
    return errorResponse(id, "invalid_request", "Missing JSON-RPC method.");
  }

  if (method == "control.ping") {
    return okResponse(id, "{\"pong\":true}");
  }

  if (method == "state.get") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"bridge_running\":true,"
           << "\"camera_running\":" << (state.cameraRunning ? "true" : "false") << ","
           << "\"preview_running\":true,"
           << "\"active_camera_index\":" << (state.activeCameraIndex >= 0 ? std::to_string(state.activeCameraIndex) : "null") << ","
           << "\"keyer_enabled\":" << (state.keyerEnabled ? "true" : "false") << ","
           << "\"last_error\":" << (camera.lastError().empty() ? "null" : "\"" + jsonEscape(camera.lastError()) + "\"") << "}";
    return okResponse(id, result.str());
  }

  if (method == "camera.list") {
    return okResponse(id, camerasToJson(camera.listCameras()));
  }

  if (method == "camera.select") {
    const int cameraIndex = extractIntField(line, "camera_index", 0);
    const bool selected = camera.selectCamera(cameraIndex);
    if (!selected) {
      return errorResponse(id, "camera_select_failed", camera.lastError());
    }
    return okResponse(id, "{\"ok\":true,\"camera_index\":" + std::to_string(cameraIndex) + ",\"selection_source\":\"native_helper\"}");
  }

  if (method == "camera.start") {
    const int cameraIndex = extractIntField(line, "camera_index", camera.activeCameraIndex());
    const bool started = camera.start(cameraIndex, options.width, options.height, options.fps);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = started;
      state.activeCameraIndex = started ? camera.activeCameraIndex() : -1;
    }
    if (!started) {
      return errorResponse(id, "camera_start_failed", camera.lastError());
    }
    return okResponse(id, "{\"ok\":true,\"camera_index\":" + std::to_string(camera.activeCameraIndex()) + ",\"backend\":\"native\"}");
  }

  if (method == "camera.stop") {
    camera.stop();
    std::lock_guard<std::mutex> lock(state.mutex);
    state.cameraRunning = false;
    state.activeCameraIndex = -1;
    return okResponse(id, "{\"ok\":true}");
  }

  if (method == "keyer.get") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"settings\":{\"enabled\":" << (state.keyerEnabled ? "true" : "false")
           << ",\"model\":\"" << jsonEscape(state.requestedKeyerModel) << "\",\"background_type\":\"mode\",\"background_mode\":\""
           << jsonEscape(state.backgroundMode)
           << "\",\"quality_mode\":\"" << jsonEscape(state.qualityMode)
           << "\",\"mask_dilate_px\":" << state.maskDilatePx
           << ",\"mask_feather_px\":" << state.maskFeatherPx
           << ",\"dynamic_dilation\":" << (state.dynamicDilation ? "true" : "false") << "},"
           << "\"status\":{\"active_keyer\":\"" << jsonEscape(state.activeKeyer)
           << "\",\"fallback_active\":" << (state.fallbackActive ? "true" : "false")
           << ",\"fallback_reason\":" << (state.fallbackReason.empty() ? "null" : "\"" + jsonEscape(state.fallbackReason) + "\"")
           << ",\"model\":\"" << jsonEscape(state.requestedKeyerModel)
           << "\",\"backend\":\"" << jsonEscape(state.keyerBackend)
           << "\",\"quality_mode\":\"" << jsonEscape(state.qualityMode)
           << "\",\"provider\":" << (state.provider.empty() ? "null" : "\"" + jsonEscape(state.provider) + "\"")
           << ",\"inference_ms\":" << (state.inferenceMs >= 0.0 ? std::to_string(state.inferenceMs) : "null")
           << ",\"model_hash_ok\":" << (state.modelHashOk ? "true" : "false")
           << ",\"model_path\":" << (state.modelPath.empty() ? "null" : "\"" + jsonEscape(state.modelPath) + "\"")
           << ",\"metrics\":" << keyerMetricsJson(state.keyerMetrics) << "}}";
    return okResponse(id, result.str());
  }

  if (method == "keyer.configure") {
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.keyerEnabled = extractBoolField(line, "enabled", state.keyerEnabled);
      const std::string model = extractStringField(line, "model");
      if (!model.empty()) {
        state.requestedKeyerModel = model;
      }
      const std::string backgroundMode = extractStringField(line, "background_mode");
      if (!backgroundMode.empty()) {
        state.backgroundMode = backgroundMode;
      }
      const std::string qualityMode = extractStringField(line, "quality_mode");
      if (!qualityMode.empty()) {
        state.qualityMode = normalizedQualityMode(qualityMode);
      }
      state.maskDilatePx = clampedPixelRadius(
          extractIntField(line, "mask_dilate_px", static_cast<int>(state.maskDilatePx)), 8u);
      state.maskFeatherPx = clampedPixelRadius(
          extractIntField(line, "mask_feather_px", static_cast<int>(state.maskFeatherPx)), 3u);
      state.dynamicDilation = extractBoolField(line, "dynamic_dilation", state.dynamicDilation);
      state.activeKeyer = "passthrough";
      state.fallbackActive = true;
      state.fallbackReason = state.keyerEnabled ? state.requestedKeyerModel + "_pending" : "keyer_disabled";
      state.keyerBackend = "passthrough";
      state.provider.clear();
      state.inferenceMs = -1.0;
      state.keyerMetrics = KeyerMetrics{};
    }
    return handleRpc("{\"id\":\"" + id + "\",\"method\":\"keyer.get\"}", state, camera, options);
  }

  if (method == "keyer.reset") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.keyerEnabled = false;
    state.activeKeyer = "passthrough";
    state.fallbackActive = true;
    state.fallbackReason = "keyer_disabled";
    state.keyerBackend = "passthrough";
    state.qualityMode = "balanced";
    state.maskDilatePx = 0u;
    state.maskFeatherPx = 0u;
    state.dynamicDilation = false;
    state.provider.clear();
    state.inferenceMs = -1.0;
    state.keyerMetrics = KeyerMetrics{};
    return okResponse(id, "{\"ok\":true,\"active_keyer\":\"passthrough\"}");
  }

  if (method == "program.get") {
    const std::string section = extractStringField(line, "section");
    if (!isProgramSection(section)) {
      return errorResponse(id, "invalid_program_section", "Unknown program section: " + section);
    }
    std::lock_guard<std::mutex> lock(state.mutex);
    return okResponse(id, programSectionJson(state, section));
  }

  if (method == "program.update") {
    const std::string section = extractStringField(line, "section");
    const std::string values = extractObjectField(line, "values");
    if (!isProgramSection(section)) {
      return errorResponse(id, "invalid_program_section", "Unknown program section: " + section);
    }
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      updateProgramSection(state, section, values);
    }
    return okResponse(id, "{\"ok\":true,\"section\":\"" + jsonEscape(section) + "\"}");
  }

  if (method == "button.list") {
    return okResponse(id,
      "{\"mode\":\"meeting\",\"buttons\":["
      "{\"id\":\"btn-keyer\",\"label\":\"AI KEYER\",\"icon\":\"sparkles\",\"enabled\":true,\"action\":{\"type\":\"keyer.toggle\"},\"group\":\"OUTPUT\",\"position\":1},"
      "{\"id\":\"btn-camera\",\"label\":\"CAMERA\",\"icon\":\"camera\",\"enabled\":true,\"action\":{\"type\":\"camera.toggle\"},\"group\":\"OUTPUT\",\"position\":2},"
      "{\"id\":\"btn-logo\",\"label\":\"LOGO\",\"icon\":\"logo\",\"enabled\":true,\"action\":{\"type\":\"logo.toggle\"},\"group\":\"OUTPUT\",\"position\":3},"
      "{\"id\":\"btn-mute\",\"label\":\"MUTE\",\"icon\":\"mic\",\"enabled\":false,\"action\":{\"type\":\"meeting.mute_toggle\"},\"group\":\"CALL\",\"position\":1}"
      "]}");
  }

  if (method == "button.trigger") {
    return okResponse(id, "{\"ok\":true,\"message\":\"Button action accepted by native helper.\"}");
  }

  if (method == "output.framebus.status") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"enabled\":true,\"running\":" << (state.framebusRunning ? "true" : "false")
           << ",\"name\":\"" << jsonEscape(options.framebusName) << "\",\"last_error\":null}";
    return okResponse(id, result.str());
  }

  if (method == "output.framebus.start") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.framebusRunning = true;
    return okResponse(id, "{\"enabled\":true,\"running\":true}");
  }

  if (method == "output.framebus.stop") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.framebusRunning = false;
    return okResponse(id, "{\"enabled\":true,\"running\":false}");
  }

  if (method == "output.framebus.configure") {
    return okResponse(id, "{\"ok\":true}");
  }

  return errorResponse(id, "unknown_method", "Unknown meeting-helper method: " + method);
}

}  // namespace

#if defined(_WIN32)
void runControlServer(const std::string &pipeName,
                      MeetingState &state,
                      CameraSource &camera,
                      const Options &options,
                      std::atomic<bool> &running) {
  while (running.load()) {
    HANDLE pipe = CreateNamedPipeA(pipeName.c_str(), PIPE_ACCESS_DUPLEX,
                                   PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                   1, 65536, 65536, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
      std::cout << "{\"type\":\"error\",\"code\":\"control_pipe_failed\",\"message\":\"Could not create control pipe.\"}" << std::endl;
      return;
    }
    BOOL connected = ConnectNamedPipe(pipe, NULL) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
    if (connected) {
      char buffer[8192];
      DWORD readBytes = 0;
      std::string pending;
      while (ReadFile(pipe, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        pending.append(buffer, buffer + readBytes);
        size_t pos = pending.find('\n');
        if (pos != std::string::npos) {
          const std::string line = pending.substr(0, pos);
          const std::string response = handleRpc(line, state, camera, options);
          DWORD written = 0;
          WriteFile(pipe, response.c_str(), (DWORD)response.size(), &written, NULL);
          break;
        }
      }
    }
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
  }
}
#else
void runControlServer(const std::string &socketPath,
                      MeetingState &state,
                      CameraSource &camera,
                      const Options &options,
                      std::atomic<bool> &running) {
  unlink(socketPath.c_str());
  int serverFd = static_cast<int>(socket(AF_UNIX, SOCK_STREAM, 0));
  if (serverFd < 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"control_socket_failed\",\"message\":\"Could not create control socket.\"}" << std::endl;
    return;
  }
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socketPath.c_str());
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 16) != 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"control_bind_failed\",\"message\":\"Could not bind control socket.\"}" << std::endl;
    close(serverFd);
    unlink(socketPath.c_str());
    return;
  }

  while (running.load()) {
    const int client = accept(serverFd, nullptr, nullptr);
    if (client < 0) {
      continue;
    }
    char buffer[8192];
    std::string pending;
    ssize_t readBytes = 0;
    while ((readBytes = read(client, buffer, sizeof(buffer))) > 0) {
      pending.append(buffer, buffer + readBytes);
      const size_t pos = pending.find('\n');
      if (pos != std::string::npos) {
        const std::string line = pending.substr(0, pos);
        const std::string response = handleRpc(line, state, camera, options);
        (void)write(client, response.c_str(), response.size());
        break;
      }
    }
    close(client);
  }
  close(serverFd);
  unlink(socketPath.c_str());
}
#endif

}  // namespace broadify::meeting
