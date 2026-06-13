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
  double maskAgeMs = -1.0;
  double programFrameMs = -1.0;
  double mjpegEncodeMs = -1.0;
  uint64_t droppedFrames = 0;
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

struct KeyerResult {
  VideoFrame frame;
  KeyerStatus status;
};

class Keyer {
 public:
  virtual ~Keyer() = default;
  virtual KeyerResult apply(const VideoFrame &input) = 0;
};

VideoFrame copyPassthroughFrame(const VideoFrame &input);

}  // namespace broadify::meeting
