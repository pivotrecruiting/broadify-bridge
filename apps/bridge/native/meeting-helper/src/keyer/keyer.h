#pragma once

#include "capture/camera_source.h"

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

struct KeyerMetrics {
  double cameraCopyMs = -1.0;
  double tensorMs = -1.0;
  double sessionRunMs = -1.0;
  double maskApplyMs = -1.0;
  double maskDilateMs = -1.0;
  double maskCloseMs = -1.0;
  double maskRemapMs = -1.0;
  double maskStabilizeMs = -1.0;
  double maskFeatherMs = -1.0;
  double maskTemporalMs = -1.0;
  double maskPostprocessMs = -1.0;
  double maskAgeMs = -1.0;
  double maskAgeAvgMs = -1.0;
  double keyerInputAgeMs = -1.0;
  double keyerProcessingMs = -1.0;
  double keyerPublishToProgramMs = -1.0;
  double programFrameIntervalMs = -1.0;
  double programFrameMs = -1.0;
  double mjpegEncodeMs = -1.0;
  double keyerFps = -1.0;
  double programFps = -1.0;
  double droppedFramesPerSec = -1.0;
  uint32_t maskWidth = 0;
  uint32_t maskHeight = 0;
  uint64_t droppedFrames = 0;
  uint64_t skippedFrames = 0;
};

struct KeyerDegradationSettings {
  double freshMaskAgeMs = 60.0;
  double maxMaskAgeMs = 220.0;
};

struct KeyerStatus {
  std::string activeKeyer = "passthrough";
  bool fallbackActive = true;
  std::string fallbackReason = "keyer_disabled";
  std::string backend = "passthrough";
  std::string qualityMode = "realtime";
  std::string provider;
  std::string modelPath;
  double inferenceMs = -1.0;
  bool modelHashOk = false;
  KeyerMetrics metrics;
};

struct AlphaMask {
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t timestampNs = 0;
  std::vector<uint8_t> alpha;
};

struct KeyerResult {
  AlphaMask mask;
  KeyerStatus status;
};

struct KeyerSettings {
  std::string qualityMode = "balanced";
  std::string performanceMode = "high_quality";
  uint32_t maxInputWidth = 1280;
  uint32_t maxInputHeight = 720;
  double maskErodePx = 0.0;
  uint32_t maskDilatePx = 0;
  uint32_t maskFeatherPx = 0;
  bool dynamicDilation = false;
  bool temporalBlendEnabled = true;
  bool edgeStabilizationEnabled = true;
  double edgeStabilizationStrength = 0.35;
  KeyerDegradationSettings degradation;
};

class Keyer {
 public:
  virtual ~Keyer() = default;
  virtual KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) = 0;
};

}  // namespace broadify::meeting
