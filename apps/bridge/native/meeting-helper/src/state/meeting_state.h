#pragma once

#include "keyer/keyer.h"

#include <mutex>
#include <string>

namespace broadify::meeting {

// Zero-config default: "balanced" is the auto profile — the keyer chain picks
// the best Vision tier the machine sustains and steps down on its own. Users
// should never need to tune keyer performance manually.
inline constexpr const char *kDefaultKeyerPerformanceMode = "balanced";

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
  std::string assetId;
  std::string renderedPagePath;
  std::string renderStatus;
  int page = 0;
  int pageCount = 0;
  double x = 0.58;
  double y = 0.12;
  double width = 0.34;
  double height = 0.28;
  // Rotation in degrees; matches the builder preview's CSS
  // rotateX() rotateY() rotateZ() order without perspective (orthographic).
  double rotation = 0.0;
  double rotationX = 0.0;
  double rotationY = 0.0;
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
  bool enabled = true;
  bool mirror = true;
  std::string rawJson = "{\"enabled\":true,\"mirror\":true}";
};

struct MeetingState {
  mutable std::mutex mutex;
  bool cameraRunning = false;
  int activeCameraIndex = -1;
  // Conference: a second open camera drawn as picture-in-picture (-1 = off).
  int pipCameraIndex = -1;
  // Conference auto-director ("Auto-Regie"): when enabled, the program feed
  // automatically follows the loudest camera microphone, with hysteresis so a
  // brief cough or door slam does not trigger a cut. Manual program selection
  // stays available and simply competes with the next auto evaluation.
  bool autoDirectorEnabled = false;
  // Minimum smoothed RMS (0..1) for a camera to be considered "someone
  // speaking". Below this the auto-director holds the current program.
  float autoDirectorThreshold = 0.02f;
  bool keyerEnabled = false;
  bool framebusRunning = true;
  bool vcamRawRunning = true;
  int previewClientCount = 0;
  int vcamClientCount = 0;
  bool graphicsDirty = true;
  bool programDirty = true;
  std::string pipelineMode = "idle";
  uint64_t programRevision = 1;
  uint64_t renderedFrames = 0;
  uint64_t reusedFrames = 0;
  uint64_t publishedPreviewFrames = 0;
  uint64_t writtenFramebusFrames = 0;
  std::string backgroundMode = "transparent";
  // Absolute file path of an uploaded company background image; empty = none.
  std::string backgroundImagePath;
  std::string activeKeyer = "passthrough";
  // Default backend: Apple Vision runs hardware-accelerated on every Mac and
  // needs no model download; MODNet stays available as an opt-in high-quality
  // backend (and remains the default where Vision is unavailable).
#if defined(__APPLE__)
  std::string requestedKeyerModel = "vision_person_segmentation";
#else
  std::string requestedKeyerModel = "modnet";
#endif
  std::string fallbackReason = "native_keyers_not_configured";
  std::string keyerBackend = "passthrough";
  std::string qualityMode = "balanced";
  std::string activeQualityMode = "balanced";
  std::string performanceMode = kDefaultKeyerPerformanceMode;
  double maskErodePx = 0.0;
  uint32_t maskDilatePx = 0;
  uint32_t maskFeatherPx = 0;
  bool dynamicDilation = false;
  bool temporalBlendEnabled = true;
  bool edgeStabilizationEnabled = true;
  double edgeStabilizationStrength = 0.35;
  KeyerDegradationSettings degradationSettings;
  std::string degradationStage = "fresh";
  // Which compositor produced the last program frame: "cpu", "d3d11", "metal".
  std::string compositorBackend = "cpu";
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
