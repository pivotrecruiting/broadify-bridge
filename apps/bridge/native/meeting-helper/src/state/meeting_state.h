#pragma once

#include "keyer/keyer.h"

#include <mutex>
#include <string>

namespace broadify::meeting {

struct SpeakerLayoutState {
  bool enabled = false;
  std::string layout = "right";
  double scale = 1.0;
  std::string rawJson = "{\"enabled\":false,\"layout\":\"right\",\"scale\":1}";
};

struct CornerbugState {
  bool enabled = false;
  double x = 0.84;
  double y = 0.08;
  double size = 0.12;
  std::string rawJson = "{\"enabled\":false,\"x\":0.84,\"y\":0.08,\"size\":0.12}";
};

struct MediaLayerState {
  bool enabled = false;
  std::string mode = "pip";
  double x = 0.58;
  double y = 0.12;
  double width = 0.34;
  double height = 0.28;
  double rotation = 0.0;
  std::string rawJson = "{\"enabled\":false,\"mode\":\"pip\",\"x\":0.58,\"y\":0.12,\"width\":0.34,\"height\":0.28,\"rotation\":0}";
};

struct GraphicsState {
  bool enabled = false;
  std::string graphicId;
  std::string templateName;
  std::string source;
  std::string handoffTarget;
  std::string rawJson = "{\"enabled\":false}";
};

struct CameraRenderState {
  bool mirror = true;
  std::string rawJson = "{\"mirror\":true}";
};

struct MeetingState {
  mutable std::mutex mutex;
  bool cameraRunning = false;
  int activeCameraIndex = -1;
  bool keyerEnabled = false;
  bool framebusRunning = true;
  bool vcamRawRunning = true;
  std::string backgroundMode = "transparent";
  std::string activeKeyer = "passthrough";
  std::string requestedKeyerModel = "modnet";
  std::string fallbackReason = "native_keyers_not_configured";
  std::string keyerBackend = "passthrough";
  std::string qualityMode = "balanced";
  double maskErodePx = 0.0;
  uint32_t maskDilatePx = 0;
  uint32_t maskFeatherPx = 0;
  bool dynamicDilation = false;
  bool temporalBlendEnabled = true;
  bool edgeStabilizationEnabled = true;
  double edgeStabilizationStrength = 0.35;
  KeyerDegradationSettings degradationSettings;
  std::string degradationStage = "fresh";
  bool staleMaskActive = false;
  std::string provider;
  std::string modelPath;
  double inferenceMs = -1.0;
  bool fallbackActive = true;
  bool modelHashOk = false;
  KeyerMetrics keyerMetrics;
  SpeakerLayoutState speakerLayout;
  CornerbugState cornerbug;
  MediaLayerState mediaLayer;
  GraphicsState graphics;
  CameraRenderState cameraRender;
};

}  // namespace broadify::meeting
