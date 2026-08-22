#include "control/control_server.h"

#include "output/vcam_controller.h"
#include "preview/preview_frame_store.h"
#include "recorder/meeting_recorder.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <iterator>
#include <sstream>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace broadify::meeting {
namespace {

#if !defined(_WIN32)
void configureSocketForShutdownChecks(int socketHandle) {
  timeval timeout{};
  timeout.tv_sec = 0;
  timeout.tv_usec = 250000;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
}
#endif

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
  if (section == "camera") {
    return state.cameraRender.rawJson;
  }
  return "{\"enabled\":false}";
}

bool isProgramSection(const std::string &section) {
  return section == "speaker_layout" || section == "cornerbug" || section == "media_layer" || section == "graphics" || section == "camera";
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

std::string normalizedPerformanceMode(const std::string &performanceMode) {
  if (performanceMode == "high_quality" || performanceMode == "quality" ||
      performanceMode == "balanced" || performanceMode == "performance") {
    return performanceMode;
  }
  return "high_quality";
}

uint32_t clampedPixelRadius(int value, uint32_t maxValue) {
  return static_cast<uint32_t>(std::clamp(value, 0, static_cast<int>(maxValue)));
}

double clampedDouble(double value, double minValue, double maxValue) {
  return std::clamp(value, minValue, maxValue);
}

KeyerDegradationSettings normalizedDegradationSettings(KeyerDegradationSettings settings) {
  settings.freshMaskAgeMs = clampedDouble(settings.freshMaskAgeMs, 0.0, 500.0);
  settings.maxMaskAgeMs = clampedDouble(settings.maxMaskAgeMs, settings.freshMaskAgeMs, 2000.0);
  return settings;
}

// Signature over every keyer.configure-relevant field; used to skip the
// disruptive status reset (passthrough/pending) when a configure call does
// not actually change anything (idempotent re-sends from the web app).
std::string keyerConfigSignature(const MeetingState &state) {
  std::ostringstream signature;
  signature << state.keyerEnabled << '|' << state.requestedKeyerModel << '|'
            << state.backgroundMode << '|' << state.backgroundImagePath << '|'
            << state.qualityMode << '|' << state.performanceMode << '|'
            << state.maskErodePx << '|' << state.maskDilatePx << '|'
            << state.maskFeatherPx << '|' << state.dynamicDilation << '|'
            << state.temporalBlendEnabled << '|' << state.edgeStabilizationEnabled << '|'
            << state.edgeStabilizationStrength << '|'
            << state.degradationSettings.freshMaskAgeMs << '|'
            << state.degradationSettings.maxMaskAgeMs;
  return signature.str();
}

int resolveCameraIndex(CameraSource &camera, const std::string &stableKey,
                       int fallbackIndex) {
  if (stableKey.empty()) {
    return fallbackIndex;
  }
  const std::vector<CameraInfo> cameras = camera.listCameras();
  const auto match = std::find_if(
      cameras.begin(), cameras.end(), [&stableKey](const CameraInfo &info) {
        return info.stableKey == stableKey || info.cameraId == stableKey;
      });
  return match == cameras.end() ? -1 : match->cameraIndex;
}

bool activeCameraMatches(CameraSource &camera, const std::string &stableKey,
                         int cameraIndex) {
  if (!camera.isRunning()) {
    return false;
  }
  const int activeIndex = camera.activeCameraIndex();
  if (stableKey.empty()) {
    return activeIndex == cameraIndex;
  }
  const std::vector<CameraInfo> cameras = camera.listCameras();
  const auto match = std::find_if(
      cameras.begin(), cameras.end(), [activeIndex](const CameraInfo &info) {
        return info.cameraIndex == activeIndex;
      });
  return match != cameras.end() &&
         (match->stableKey == stableKey || match->cameraId == stableKey);
}

void markProgramDirty(MeetingState &state, bool graphicsDirty = false) {
  state.programDirty = true;
  state.graphicsDirty = state.graphicsDirty || graphicsDirty;
  ++state.programRevision;
}

std::string keyerMetricsJson(const KeyerMetrics &metrics) {
  std::ostringstream result;
  result << "{\"camera_copy_ms\":" << metricNumber(metrics.cameraCopyMs)
         << ",\"tensor_ms\":" << metricNumber(metrics.tensorMs)
         << ",\"session_run_ms\":" << metricNumber(metrics.sessionRunMs)
         << ",\"mask_apply_ms\":" << metricNumber(metrics.maskApplyMs)
         << ",\"mask_dilate_ms\":" << metricNumber(metrics.maskDilateMs)
         << ",\"mask_close_ms\":" << metricNumber(metrics.maskCloseMs)
         << ",\"mask_remap_ms\":" << metricNumber(metrics.maskRemapMs)
         << ",\"mask_stabilize_ms\":" << metricNumber(metrics.maskStabilizeMs)
         << ",\"mask_feather_ms\":" << metricNumber(metrics.maskFeatherMs)
         << ",\"mask_temporal_ms\":" << metricNumber(metrics.maskTemporalMs)
         << ",\"mask_postprocess_ms\":" << metricNumber(metrics.maskPostprocessMs)
         << ",\"mask_age_ms\":" << metricNumber(metrics.maskAgeMs)
         << ",\"mask_age_avg_ms\":" << metricNumber(metrics.maskAgeAvgMs)
         << ",\"keyer_input_age_ms\":" << metricNumber(metrics.keyerInputAgeMs)
         << ",\"keyer_processing_ms\":" << metricNumber(metrics.keyerProcessingMs)
         << ",\"keyer_publish_to_program_ms\":" << metricNumber(metrics.keyerPublishToProgramMs)
         << ",\"program_frame_interval_ms\":" << metricNumber(metrics.programFrameIntervalMs)
         << ",\"program_frame_ms\":" << metricNumber(metrics.programFrameMs)
         << ",\"mjpeg_encode_ms\":" << metricNumber(metrics.mjpegEncodeMs)
         << ",\"keyer_fps\":" << metricNumber(metrics.keyerFps)
         << ",\"program_fps\":" << metricNumber(metrics.programFps)
         << ",\"dropped_frames_per_sec\":" << metricNumber(metrics.droppedFramesPerSec)
         << ",\"mask_width\":" << metrics.maskWidth
         << ",\"mask_height\":" << metrics.maskHeight
         << ",\"dropped_frames\":" << metrics.droppedFrames
         << ",\"skipped_frames\":" << metrics.skippedFrames
         << ",\"camera_texture_uploads\":" << metrics.cameraTextureUploads
         << ",\"staging_readback_depth\":" << metrics.stagingReadbackDepth
         << "}";
  return result.str();
}

void updateProgramSection(MeetingState &state, const std::string &section, const std::string &values) {
  const std::string safeValues = values.empty() ? "{\"enabled\":false}" : values;
  if (section == "speaker_layout") {
    state.speakerLayout.enabled = extractBoolField(safeValues, "enabled", state.speakerLayout.enabled);
    state.cameraRender.enabled = extractBoolField(safeValues, "camera_enabled", state.cameraRender.enabled);
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
    // Presence-guarded logo image: while the webapp re-fetches the logo's
    // data URL (signed URLs refresh after reconnects) it omits the field —
    // carry the current image over instead of wiping the on-air logo. An
    // explicit null/empty image_data_url still clears it. Data URLs contain
    // no quotes, so splicing the old value into the new JSON is safe.
    std::string nextRawJson = safeValues;
    if (nextRawJson.find("\"image_data_url\"") == std::string::npos) {
      const std::string previousImage =
          extractStringField(state.cornerbug.rawJson, "image_data_url");
      if (!previousImage.empty() && nextRawJson.size() >= 2 && nextRawJson.front() == '{') {
        nextRawJson.insert(1, "\"image_data_url\":\"" + previousImage + "\",");
      }
    }
    state.cornerbug.rawJson = nextRawJson;
    return;
  }
  if (section == "media_layer") {
    state.mediaLayer.enabled = extractBoolField(safeValues, "enabled", state.mediaLayer.enabled);
    const std::string mode = extractStringField(safeValues, "mode");
    if (!mode.empty()) {
      state.mediaLayer.mode = mode;
    }
    state.mediaLayer.assetId = extractStringField(safeValues, "asset_id");
    state.mediaLayer.renderedPagePath = extractStringField(safeValues, "rendered_page_path");
    state.mediaLayer.renderStatus = extractStringField(safeValues, "render_status");
    state.mediaLayer.page = extractIntField(safeValues, "page", state.mediaLayer.page);
    state.mediaLayer.pageCount = extractIntField(safeValues, "page_count", state.mediaLayer.pageCount);
    state.mediaLayer.x = extractDoubleField(safeValues, "x", state.mediaLayer.x);
    state.mediaLayer.y = extractDoubleField(safeValues, "y", state.mediaLayer.y);
    state.mediaLayer.width = extractDoubleField(safeValues, "width", state.mediaLayer.width);
    state.mediaLayer.height = extractDoubleField(safeValues, "height", state.mediaLayer.height);
    state.mediaLayer.rotation = extractDoubleField(safeValues, "rotation", state.mediaLayer.rotation);
    state.mediaLayer.rotationX = extractDoubleField(safeValues, "rotation_x", state.mediaLayer.rotationX);
    state.mediaLayer.rotationY = extractDoubleField(safeValues, "rotation_y", state.mediaLayer.rotationY);
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
    return;
  }
  if (section == "camera") {
    state.cameraRender.enabled = extractBoolField(safeValues, "enabled", state.cameraRender.enabled);
    state.cameraRender.mirror = extractBoolField(safeValues, "mirror", state.cameraRender.mirror);
    state.cameraRender.rawJson = std::string("{\"enabled\":") + (state.cameraRender.enabled ? "true" : "false") +
        ",\"mirror\":" + (state.cameraRender.mirror ? "true" : "false") + "}";
  }
}

std::string recordingStatusJson(MeetingRecorder &recorder) {
  const RecordingStatus s = recorder.status();
  std::ostringstream out;
  out << "{\"ok\":true,\"recording\":{"
      << "\"active\":" << (s.active ? "true" : "false") << ","
      << "\"file_path\":\"" << jsonEscape(s.filePath) << "\","
      << "\"elapsed_seconds\":" << s.elapsedSeconds << ","
      << "\"video_frames\":" << s.videoFrames << ","
      << "\"last_error\":\"" << jsonEscape(s.lastError) << "\"}}";
  return out.str();
}

std::string handleRpc(const std::string &line,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      const Options &options,
                      std::atomic<bool> &running) {
  const std::string id = extractStringField(line, "id");
  const std::string method = extractStringField(line, "method");
  if (method.empty()) {
    return errorResponse(id, "invalid_request", "Missing JSON-RPC method.");
  }

  if (method == "control.ping") {
    return okResponse(id, "{\"pong\":true}");
  }

  if (method == "control.shutdown") {
    previewFrames.clear();
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.framebusRunning = false;
      state.vcamRawRunning = false;
    }
    stopVirtualCamera();
    // Finalize an in-flight recording while the RPC caller is still waiting:
    // the main() exit path also stops the recorder, but only after this
    // response has been sent and the bridge may already be killing us. stop()
    // is a no-op when nothing is recording.
    recorder.stop();
    noteHelperExitReason("control_shutdown");
    running.store(false);
    return okResponse(id, "{\"ok\":true}");
  }

  if (method == "state.get") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"bridge_running\":true,"
           << "\"camera_running\":" << (state.cameraRunning ? "true" : "false") << ","
           << "\"camera_stalled\":" << (state.cameraStalled ? "true" : "false") << ","
           << "\"preview_running\":true,"
           << "\"active_camera_index\":" << (state.activeCameraIndex >= 0 ? std::to_string(state.activeCameraIndex) : "null") << ","
           << "\"pip_camera_index\":" << (state.pipCameraIndex >= 0 ? std::to_string(state.pipCameraIndex) : "null") << ","
           << "\"auto_director_enabled\":" << (state.autoDirectorEnabled ? "true" : "false") << ","
           << "\"keyer_enabled\":" << (state.keyerEnabled ? "true" : "false") << ","
           << "\"pipeline_mode\":\"" << jsonEscape(state.pipelineMode) << "\","
           << "\"keyer_provider\":" << (state.provider.empty() ? "null" : "\"" + jsonEscape(state.provider) + "\"") << ","
           << "\"gpu_adapter\":" << (state.gpuAdapter.empty() ? "null" : "\"" + jsonEscape(state.gpuAdapter) + "\"") << ","
           << "\"compositor_adapter\":" << (state.compositorAdapter.empty() ? "null" : "\"" + jsonEscape(state.compositorAdapter) + "\"") << ","
           << "\"preview_clients\":" << state.previewClientCount << ","
           << "\"vcam_clients\":" << state.vcamClientCount << ","
           << "\"framebus_running\":" << (state.framebusRunning ? "true" : "false") << ","
           << "\"program_dirty\":" << (state.programDirty ? "true" : "false") << ","
           << "\"graphics_dirty\":" << (state.graphicsDirty ? "true" : "false") << ","
           << "\"rendered_frames\":" << state.renderedFrames << ","
           << "\"reused_frames\":" << state.reusedFrames << ","
           << "\"published_preview_frames\":" << state.publishedPreviewFrames << ","
           << "\"written_framebus_frames\":" << state.writtenFramebusFrames << ","
           << "\"camera_permission_status\":\"" << jsonEscape(camera.cameraPermissionStatus()) << "\","
           << "\"camera_last_error\":" << (camera.lastError().empty() ? "null" : "\"" + jsonEscape(camera.lastError()) + "\"") << ","
           << "\"last_error\":" << (camera.lastError().empty() ? "null" : "\"" + jsonEscape(camera.lastError()) + "\"") << "}";
    return okResponse(id, result.str());
  }

  if (method == "camera.list") {
    const std::vector<CameraInfo> cameras = camera.listCameras();
    const std::string lastError = camera.lastError();
    const std::string permissionStatus = camera.cameraPermissionStatus();
    if (cameras.empty() && !lastError.empty()) {
      const std::string code = permissionStatus == "denied" || permissionStatus == "restricted"
          ? "camera_permission_denied"
          : "camera_discovery_failed";
      return errorResponse(id, code, lastError);
    }
    return okResponse(id, camerasToJson(cameras));
  }

  if (method == "camera.permission.request") {
    const std::string permissionStatus = camera.requestCameraPermission();
    return okResponse(id, "{\"camera_permission_status\":\"" + jsonEscape(permissionStatus) + "\"}");
  }

  if (method == "camera.select") {
    const std::string stableKey = extractStringField(line, "stable_key");
    const int cameraIndex = resolveCameraIndex(
        camera, stableKey, extractIntField(line, "camera_index", 0));
    if (cameraIndex < 0) {
      return errorResponse(id, "camera_select_failed",
                           "Requested camera stable_key is not available.");
    }
    const bool selected = camera.selectCamera(cameraIndex);
    if (!selected) {
      return errorResponse(id, "camera_select_failed", camera.lastError());
    }
    return okResponse(id, "{\"ok\":true,\"camera_index\":" + std::to_string(cameraIndex) + ",\"selection_source\":\"native_helper\"}");
  }

  if (method == "camera.start") {
    const std::string stableKey = extractStringField(line, "stable_key");
    const int cameraIndex = resolveCameraIndex(
        camera, stableKey, extractIntField(line, "camera_index", camera.activeCameraIndex()));
    if (cameraIndex < 0) {
      return errorResponse(id, "camera_start_failed",
                           "Requested camera stable_key is not available.");
    }
    bool cameraStalled = false;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      cameraStalled = state.cameraStalled;
    }
    if (!cameraStalled && activeCameraMatches(camera, stableKey, cameraIndex)) {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = true;
      state.activeCameraIndex = cameraIndex;
      state.cameraStalled = false;
      return okResponse(id, "{\"ok\":true,\"camera_index\":" + std::to_string(cameraIndex) + ",\"backend\":\"native\",\"reopened\":false}");
    }
    const bool started = camera.start(cameraIndex, options.width, options.height, options.fps);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = started;
      state.activeCameraIndex = started ? camera.activeCameraIndex() : -1;
      state.cameraStalled = false;
      markProgramDirty(state);
    }
    if (!started) {
      const std::string permissionStatus = camera.cameraPermissionStatus();
      const std::string code = permissionStatus == "denied" || permissionStatus == "restricted"
          ? "camera_permission_denied"
          : "camera_start_failed";
      return errorResponse(id, code, camera.lastError());
    }
    return okResponse(id, "{\"ok\":true,\"camera_index\":" + std::to_string(camera.activeCameraIndex()) + ",\"backend\":\"native\",\"reopened\":true}");
  }

  if (method == "camera.reopen") {
    if (!camera.isRunning()) {
      return okResponse(id, "{\"ok\":true,\"reopened\":false}");
    }
    const bool reopened = camera.reopen(options.width, options.height, options.fps);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = camera.isRunning();
      state.activeCameraIndex = state.cameraRunning ? camera.activeCameraIndex() : -1;
      state.cameraStalled = !reopened;
      markProgramDirty(state);
    }
    if (!reopened) {
      return errorResponse(id, "camera_reopen_failed", camera.lastError());
    }
    return okResponse(id, "{\"ok\":true,\"reopened\":true,\"camera_index\":" + std::to_string(camera.activeCameraIndex()) + "}");
  }

  if (method == "camera.stop") {
    camera.stop();
    previewFrames.clear();
    std::lock_guard<std::mutex> lock(state.mutex);
    state.cameraRunning = false;
    state.cameraStalled = false;
    state.activeCameraIndex = -1;
    markProgramDirty(state);
    return okResponse(id, "{\"ok\":true}");
  }

  if (method == "recording.microphones") {
    const std::vector<MicrophoneInfo> mics = recorder.listMicrophones();
    std::ostringstream out;
    out << "{\"ok\":true,\"microphones\":[";
    for (size_t i = 0; i < mics.size(); ++i) {
      if (i > 0) {
        out << ",";
      }
      out << "{\"device_id\":\"" << jsonEscape(mics[i].deviceId) << "\","
          << "\"label\":\"" << jsonEscape(mics[i].label) << "\","
          << "\"is_default\":" << (mics[i].isDefault ? "true" : "false")
          << "}";
    }
    out << "]}";
    return okResponse(id, out.str());
  }

  if (method == "recording.start") {
    const std::string filePath = extractStringField(line, "file_path");
    const std::string micDeviceId = extractStringField(line, "mic_device_id");
    if (filePath.empty()) {
      return errorResponse(id, "invalid_request",
                           "recording.start requires file_path.");
    }
    const bool started = recorder.start(filePath, micDeviceId, options.width,
                                        options.height, options.fps);
    if (!started) {
      return errorResponse(id, "recording_start_failed",
                           recorder.status().lastError);
    }
    return okResponse(id, recordingStatusJson(recorder));
  }

  if (method == "recording.stop") {
    recorder.stop();
    return okResponse(id, recordingStatusJson(recorder));
  }

  if (method == "recording.status") {
    return okResponse(id, recordingStatusJson(recorder));
  }

  // Conference: open several cameras at once. Payload
  // "camera_indices":[0,1,2] — the first becomes the program feed. The others
  // stay running so program_select can cut between them with no reopen.
  if (method == "camera.open_set") {
    std::vector<int> indices;
    const std::string key = "\"camera_indices\"";
    const size_t keyPos = line.find(key);
    if (keyPos != std::string::npos) {
      const size_t open = line.find('[', keyPos);
      const size_t close = open == std::string::npos
                               ? std::string::npos
                               : line.find(']', open);
      if (open != std::string::npos && close != std::string::npos) {
        const std::string inner = line.substr(open + 1, close - open - 1);
        std::stringstream ss(inner);
        std::string token;
        while (std::getline(ss, token, ',')) {
          try {
            indices.push_back(std::stoi(token));
          } catch (...) {
          }
        }
      }
    }
    const bool started =
        camera.startSet(indices, options.width, options.height, options.fps);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = started;
      state.activeCameraIndex = started ? camera.activeCameraIndex() : -1;
      markProgramDirty(state);
    }
    if (!started) {
      const std::string permissionStatus = camera.cameraPermissionStatus();
      const std::string code =
          permissionStatus == "denied" || permissionStatus == "restricted"
              ? "camera_permission_denied"
              : "camera_start_failed";
      return errorResponse(id, code, camera.lastError());
    }
    const std::vector<int> openSet = camera.activeCameraSet();
    std::ostringstream result;
    result << "{\"ok\":true,\"program_index\":" << camera.activeCameraIndex()
           << ",\"open\":[";
    for (size_t i = 0; i < openSet.size(); ++i) {
      result << (i ? "," : "") << openSet[i];
    }
    result << "]}";
    return okResponse(id, result.str());
  }

  // Conference: cut the program feed to an already-open camera (seamless).
  if (method == "camera.program_select") {
    const int cameraIndex = extractIntField(line, "camera_index", 0);
    if (!camera.setProgramCamera(cameraIndex)) {
      return errorResponse(id, "camera_program_select_failed",
                           camera.lastError());
    }
    std::lock_guard<std::mutex> lock(state.mutex);
    state.activeCameraIndex = camera.activeCameraIndex();
    markProgramDirty(state);
    return okResponse(
        id, "{\"ok\":true,\"program_index\":" + std::to_string(cameraIndex) +
                "}");
  }

  // Conference: draw an open camera as picture-in-picture (-1 = off).
  if (method == "camera.pip_set") {
    const int cameraIndex = extractIntField(line, "camera_index", -1);
    std::lock_guard<std::mutex> lock(state.mutex);
    state.pipCameraIndex = cameraIndex;
    markProgramDirty(state);
    return okResponse(
        id, "{\"ok\":true,\"pip_index\":" + std::to_string(cameraIndex) + "}");
  }

  // Conference auto-director: per-camera microphone level (0..1) of the open
  // cameras, for the loudest-speaker switching logic.
  if (method == "camera.audio_levels") {
    const std::map<int, float> levels = camera.cameraAudioLevels();
    std::ostringstream result;
    result << "{\"ok\":true,\"levels\":{";
    bool first = true;
    for (const auto &entry : levels) {
      result << (first ? "" : ",") << "\"" << entry.first
             << "\":" << entry.second;
      first = false;
    }
    result << "}}";
    return okResponse(id, result.str());
  }

  // Conference auto-director on/off (+ optional speech threshold). The pipeline
  // loop reads these flags and cuts the program to the loudest camera.
  if (method == "camera.auto_director") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.autoDirectorEnabled =
        extractBoolField(line, "enabled", state.autoDirectorEnabled);
    const double threshold =
        extractDoubleField(line, "threshold", state.autoDirectorThreshold);
    if (threshold > 0.0 && threshold < 1.0) {
      state.autoDirectorThreshold = static_cast<float>(threshold);
    }
    std::ostringstream result;
    result << "{\"ok\":true,\"auto_director\":"
           << (state.autoDirectorEnabled ? "true" : "false")
           << ",\"threshold\":" << state.autoDirectorThreshold << "}";
    return okResponse(id, result.str());
  }

  if (method == "keyer.get") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"settings\":{\"enabled\":" << (state.keyerEnabled ? "true" : "false")
           << ",\"model\":\"" << jsonEscape(state.requestedKeyerModel) << "\",\"background_type\":\"mode\",\"background_mode\":\""
           << jsonEscape(state.backgroundMode)
           << "\",\"quality_mode\":\"" << jsonEscape(state.qualityMode)
           << "\",\"performance_mode\":\"" << jsonEscape(state.performanceMode)
           << "\",\"mask_erode_px\":" << state.maskErodePx
           << ",\"mask_dilate_px\":" << state.maskDilatePx
           << ",\"mask_feather_px\":" << state.maskFeatherPx
           << ",\"dynamic_dilation\":" << (state.dynamicDilation ? "true" : "false")
           << ",\"temporal_blend_enabled\":" << (state.temporalBlendEnabled ? "true" : "false")
           << ",\"edge_stabilization_enabled\":" << (state.edgeStabilizationEnabled ? "true" : "false")
           << ",\"edge_stabilization_strength\":" << state.edgeStabilizationStrength
           << ",\"fresh_mask_age_ms\":" << state.degradationSettings.freshMaskAgeMs
           << ",\"max_mask_age_ms\":" << state.degradationSettings.maxMaskAgeMs << "},"
           << "\"status\":{\"active_keyer\":\"" << jsonEscape(state.activeKeyer)
           << "\",\"fallback_active\":" << (state.fallbackActive ? "true" : "false")
           << ",\"keyer_degraded\":" << (state.keyerDegraded ? "true" : "false")
           << ",\"fallback_reason\":" << (state.fallbackReason.empty() ? "null" : "\"" + jsonEscape(state.fallbackReason) + "\"")
           << ",\"degradation_stage\":\"" << jsonEscape(state.degradationStage)
           << "\",\"compositor\":\"" << jsonEscape(state.compositorBackend)
           << "\",\"gpu_adapter\":" << (state.gpuAdapter.empty() ? "null" : "\"" + jsonEscape(state.gpuAdapter) + "\"")
           << ",\"compositor_adapter\":" << (state.compositorAdapter.empty() ? "null" : "\"" + jsonEscape(state.compositorAdapter) + "\"")
           << ",\"stale_mask_active\":" << (state.staleMaskActive ? "true" : "false")
           << ",\"model\":\"" << jsonEscape(state.requestedKeyerModel)
           << "\",\"backend\":\"" << jsonEscape(state.keyerBackend)
           << "\",\"quality_mode\":\"" << jsonEscape(state.activeQualityMode)
           << "\",\"performance_mode\":\"" << jsonEscape(state.performanceMode)
           << "\",\"active_performance_mode\":" << (state.activePerformanceMode.empty() ? "null" : "\"" + jsonEscape(state.activePerformanceMode) + "\"")
           << ",\"provider\":" << (state.provider.empty() ? "null" : "\"" + jsonEscape(state.provider) + "\"")
           << ",\"inference_ms\":" << (state.inferenceMs >= 0.0 ? std::to_string(state.inferenceMs) : "null")
           << ",\"model_hash_ok\":" << (state.modelHashOk ? "true" : "false")
           << ",\"model_path\":" << (state.modelPath.empty() ? "null" : "\"" + jsonEscape(state.modelPath) + "\"")
           << ",\"pipeline_mode\":\"" << jsonEscape(state.pipelineMode)
           << "\",\"keyer_pipeline_mode\":" << (state.keyerPipelineMode.empty() ? "null" : "\"" + jsonEscape(state.keyerPipelineMode) + "\"")
           << ",\"preview_clients\":" << state.previewClientCount
           << ",\"vcam_clients\":" << state.vcamClientCount
           << ",\"program_dirty\":" << (state.programDirty ? "true" : "false")
           << ",\"graphics_dirty\":" << (state.graphicsDirty ? "true" : "false")
           << ",\"rendered_frames\":" << state.renderedFrames
           << ",\"reused_frames\":" << state.reusedFrames
           << ",\"published_preview_frames\":" << state.publishedPreviewFrames
           << ",\"written_framebus_frames\":" << state.writtenFramebusFrames
           << ",\"metrics\":" << keyerMetricsJson(state.keyerMetrics) << "}}";
    return okResponse(id, result.str());
  }

  if (method == "keyer.configure") {
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      const std::string signatureBefore = keyerConfigSignature(state);
      state.keyerEnabled = extractBoolField(line, "enabled", state.keyerEnabled);
      const std::string model = extractStringField(line, "model");
      if (!model.empty()) {
        state.requestedKeyerModel = model;
      }
      const std::string backgroundMode = extractStringField(line, "background_mode");
      if (!backgroundMode.empty()) {
        state.backgroundMode = backgroundMode;
      }
      // Sent with every keyer configure (empty string clears the image).
      // Presence-guarded: several callers (builder live-test start, the
      // connections/buttons pages, conference safety nets) send keyer patches
      // WITHOUT this field — that must keep the current background, otherwise
      // every such patch silently wipes it back to default. Only an explicit
      // empty string clears the image.
      if (line.find("\"background_image_path\"") != std::string::npos) {
        state.backgroundImagePath = extractStringField(line, "background_image_path");
      }
      const std::string qualityMode = extractStringField(line, "quality_mode");
      if (!qualityMode.empty()) {
        state.qualityMode = normalizedQualityMode(qualityMode);
        state.activeQualityMode = state.qualityMode;
      }
      const std::string performanceMode = extractStringField(line, "performance_mode");
      if (!performanceMode.empty()) {
        state.performanceMode = normalizedPerformanceMode(performanceMode);
      }
      state.maskErodePx = clampedDouble(extractDoubleField(line, "mask_erode_px", state.maskErodePx), 0.0, 3.0);
      state.maskDilatePx = clampedPixelRadius(
          extractIntField(line, "mask_dilate_px", static_cast<int>(state.maskDilatePx)), 8u);
      state.maskFeatherPx = clampedPixelRadius(
          extractIntField(line, "mask_feather_px", static_cast<int>(state.maskFeatherPx)), 3u);
      state.dynamicDilation = extractBoolField(line, "dynamic_dilation", state.dynamicDilation);
      state.temporalBlendEnabled = extractBoolField(line, "temporal_blend_enabled", state.temporalBlendEnabled);
      state.edgeStabilizationEnabled =
          extractBoolField(line, "edge_stabilization_enabled", state.edgeStabilizationEnabled);
      state.edgeStabilizationStrength =
          clampedDouble(extractDoubleField(line, "edge_stabilization_strength", state.edgeStabilizationStrength), 0.0, 1.0);
      KeyerDegradationSettings degradation = state.degradationSettings;
      degradation.freshMaskAgeMs = extractDoubleField(line, "fresh_mask_age_ms", degradation.freshMaskAgeMs);
      degradation.maxMaskAgeMs = extractDoubleField(line, "max_mask_age_ms", degradation.maxMaskAgeMs);
      state.degradationSettings = normalizedDegradationSettings(degradation);
      if (keyerConfigSignature(state) != signatureBefore) {
        state.activeKeyer = "passthrough";
        state.fallbackActive = true;
        state.fallbackReason = state.keyerEnabled ? state.requestedKeyerModel + "_pending" : "keyer_disabled";
        state.keyerBackend = "passthrough";
        state.degradationStage = "fresh";
        state.staleMaskActive = false;
        state.provider.clear();
        state.inferenceMs = -1.0;
        state.keyerMetrics = KeyerMetrics{};
        markProgramDirty(state);
      }
    }
    return handleRpc("{\"id\":\"" + id + "\",\"method\":\"keyer.get\"}", state, camera, previewFrames, recorder, options, running);
  }

  if (method == "keyer.reset") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.keyerEnabled = false;
    state.activeKeyer = "passthrough";
    state.fallbackActive = true;
    state.fallbackReason = "keyer_disabled";
    state.keyerBackend = "passthrough";
    state.qualityMode = "balanced";
    state.activeQualityMode = "balanced";
    state.backgroundImagePath.clear();
    state.performanceMode = kDefaultKeyerPerformanceMode;
    state.maskErodePx = 0.0;
    state.maskDilatePx = 0u;
    state.maskFeatherPx = 0u;
    state.dynamicDilation = false;
    state.temporalBlendEnabled = true;
    state.edgeStabilizationEnabled = true;
    state.edgeStabilizationStrength = 0.35;
    state.degradationSettings = KeyerDegradationSettings{};
    state.degradationStage = "fresh";
    state.staleMaskActive = false;
    state.provider.clear();
    state.inferenceMs = -1.0;
    state.keyerMetrics = KeyerMetrics{};
    markProgramDirty(state);
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
      markProgramDirty(state, section == "graphics");
    }
    return okResponse(id, "{\"ok\":true,\"section\":\"" + jsonEscape(section) + "\"}");
  }

  if (method == "output.framebus.status") {
    std::lock_guard<std::mutex> lock(state.mutex);
    std::ostringstream result;
    result << "{\"enabled\":true,\"running\":" << (state.framebusRunning ? "true" : "false")
           << ",\"name\":\"" << jsonEscape(options.framebusName) << "\",\"last_error\":null}";
    return okResponse(id, result.str());
  }

  // The FrameBus output (shared memory, read by the conference display
  // output) and the raw-frame TCP stream (read by the virtual-camera
  // consumers) are independent outputs: toggling one must not black out the
  // other.
  if (method == "output.framebus.start") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.framebusRunning = true;
    markProgramDirty(state);
    return okResponse(id, "{\"enabled\":true,\"running\":true}");
  }

  if (method == "output.framebus.stop") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.framebusRunning = false;
    markProgramDirty(state);
    return okResponse(id, "{\"enabled\":true,\"running\":false}");
  }

  if (method == "output.vcam.raw.start") {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = true;
    markProgramDirty(state);
    return okResponse(id, "{\"enabled\":true,\"running\":true}");
  }

  if (method == "output.vcam.raw.stop") {
    previewFrames.clear();
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = false;
    markProgramDirty(state);
    return okResponse(id, "{\"enabled\":true,\"running\":false}");
  }

  if (method == "output.framebus.configure") {
    return okResponse(id, "{\"ok\":true}");
  }

  if (method == "output.vcam.start") {
    std::string vcamError;
    if (startVirtualCamera(vcamError)) {
      return okResponse(id, "{\"ok\":true,\"active\":true}");
    }
    return errorResponse(id, "vcam_start_failed", vcamError);
  }

  if (method == "output.vcam.stop") {
    stopVirtualCamera();
    return okResponse(id, "{\"ok\":true,\"active\":false}");
  }

  if (method == "output.vcam.status") {
    const VcamStatus vcam = virtualCameraStatus();
    std::ostringstream result;
    result << "{\"active\":" << (vcam.active ? "true" : "false")
           << ",\"supported\":" << (vcam.supported ? "true" : "false")
           << ",\"last_error\":"
           << (vcam.lastError.empty() ? "null"
                                      : "\"" + jsonEscape(vcam.lastError) + "\"")
           << "}";
    return okResponse(id, result.str());
  }

  return errorResponse(id, "unknown_method", "Unknown meeting-helper method: " + method);
}

}  // namespace

#if defined(_WIN32)
namespace {

constexpr DWORD CONTROL_PIPE_BUFFER_BYTES = 65536;
// ~10 s of 50 ms retries before the control channel is declared dead.
constexpr int CONTROL_PIPE_CREATE_MAX_CONSECUTIVE_FAILURES = 200;
constexpr DWORD CONTROL_PIPE_CREATE_RETRY_DELAY_MS = 50;

// Creates one listening instance of the control pipe. CreateNamedPipeA can
// fail transiently (e.g. ERROR_PIPE_BUSY while libuv is still closing the
// previous client handle); a single such failure used to end the control
// thread for good while the helper process kept running - a silent, permanent
// ENOENT for every later bridge RPC. Retry with a bounded budget instead and
// report control_pipe_failed only once that budget is exhausted. Returns
// INVALID_HANDLE_VALUE after the final failure or when `running` turned false.
HANDLE createControlPipeInstance(const std::string &pipeName, std::atomic<bool> &running) {
  int consecutiveFailures = 0;
  while (running.load()) {
    HANDLE pipe = CreateNamedPipeA(pipeName.c_str(), PIPE_ACCESS_DUPLEX,
                                   PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                   PIPE_UNLIMITED_INSTANCES, CONTROL_PIPE_BUFFER_BYTES,
                                   CONTROL_PIPE_BUFFER_BYTES, 0, NULL);
    if (pipe != INVALID_HANDLE_VALUE) {
      return pipe;
    }
    const DWORD lastError = GetLastError();
    consecutiveFailures += 1;
    if (consecutiveFailures >= CONTROL_PIPE_CREATE_MAX_CONSECUTIVE_FAILURES) {
      emitHelperEvent(
          "{\"type\":\"error\",\"code\":\"control_pipe_failed\","
          "\"message\":\"Could not create control pipe.\",\"win32_error\":" +
          std::to_string(lastError) + ",\"attempts\":" + std::to_string(consecutiveFailures) + "}");
      return INVALID_HANDLE_VALUE;
    }
    emitHelperEvent(
        "{\"type\":\"control_pipe_retry\",\"win32_error\":" + std::to_string(lastError) +
        ",\"attempt\":" + std::to_string(consecutiveFailures) + "}");
    Sleep(CONTROL_PIPE_CREATE_RETRY_DELAY_MS);
  }
  return INVALID_HANDLE_VALUE;
}

}  // namespace

void runControlServer(const std::string &pipeName,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      const Options &options,
                      std::atomic<bool> &running,
                      const std::function<void()> &onListening) {
  // Create the first instance BEFORE signalling readiness: the bridge starts
  // pinging as soon as it sees `ready`, and a pipe that does not exist yet is
  // indistinguishable (ENOENT) from a dead helper. If no instance can be
  // created the ready signal is withheld on purpose, so the bridge's start
  // timeout fires with control_pipe_failed as the visible cause.
  HANDLE pipe = createControlPipeInstance(pipeName, running);
  if (pipe == INVALID_HANDLE_VALUE) {
    return;
  }
  if (onListening) {
    onListening();
  }
  while (running.load()) {
    BOOL connected = ConnectNamedPipe(pipe, NULL) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
    // Open the next instance before serving this client. With a single
    // instance there was a window between DisconnectNamedPipe/CloseHandle and
    // the next CreateNamedPipeA in which no pipe existed at all, and bridge
    // RPC bursts (engine start, status polls) hit ENOENT there - libuv retries
    // ERROR_PIPE_BUSY on its own but not ERROR_FILE_NOT_FOUND. RPC handling
    // stays sequential: the spare instance only parks the next client until
    // this loop comes back around.
    HANDLE nextPipe = createControlPipeInstance(pipeName, running);
    if (connected) {
      char buffer[8192];
      DWORD readBytes = 0;
      std::string pending;
      while (ReadFile(pipe, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        pending.append(buffer, buffer + readBytes);
        size_t pos = pending.find('\n');
        if (pos != std::string::npos) {
          const std::string line = pending.substr(0, pos);
          const std::string response = handleRpc(line, state, camera, previewFrames, recorder, options, running);
          DWORD written = 0;
          WriteFile(pipe, response.c_str(), (DWORD)response.size(), &written, NULL);
          // Block until the client has read the response; without this,
          // DisconnectNamedPipe below discards any unread data and the
          // client sees an empty reply (lost fast-command responses).
          FlushFileBuffers(pipe);
          break;
        }
      }
    }
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    if (nextPipe == INVALID_HANDLE_VALUE) {
      // Either shutting down (running == false) or control_pipe_failed was
      // already reported by createControlPipeInstance.
      return;
    }
    pipe = nextPipe;
  }
  // Loop left via control.shutdown: release the parked spare instance.
  CloseHandle(pipe);
}
#else
void runControlServer(const std::string &socketPath,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      const Options &options,
                      std::atomic<bool> &running,
                      const std::function<void()> &onListening) {
  unlink(socketPath.c_str());
  int serverFd = static_cast<int>(socket(AF_UNIX, SOCK_STREAM, 0));
  if (serverFd < 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"control_socket_failed\",\"message\":\"Could not create control socket.\"}" << std::endl;
    return;
  }
  configureSocketForShutdownChecks(serverFd);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socketPath.c_str());
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 16) != 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"control_bind_failed\",\"message\":\"Could not bind control socket.\"}" << std::endl;
    close(serverFd);
    unlink(socketPath.c_str());
    return;
  }

  if (onListening) {
    onListening();
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
        const std::string response = handleRpc(line, state, camera, previewFrames, recorder, options, running);
        if (write(client, response.c_str(), response.size()) < 0) {
          // The bridge destroyed its socket first (RPC timeout). Before
          // SIGPIPE was ignored this write ended the whole process silently;
          // now it is a visible, non-fatal incident.
          emitHelperEvent(
              "{\"type\":\"control_write_failed\",\"errno\":" +
              std::to_string(errno) + "}");
        }
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
