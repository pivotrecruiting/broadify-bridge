#pragma once

#include "capture/camera_source.h"

#include <cstdint>

namespace broadify::meeting {

// Maps a destination pixel center to a continuous source pixel coordinate.
struct GpuLayerMapping {
  bool present = false;
  bool keyed = false;
  bool mirror = false;
  float scaleX = 1.0f;
  float scaleY = 1.0f;
  float biasX = 0.0f;
  float biasY = 0.0f;
  float mirrorConst = 0.0f;
};

struct GpuComposePlan {
  uint32_t width = 0;
  uint32_t height = 0;
  // 0 dark, 1 gradient, 2 solid_light, 3 checkerboard, 4 transparent.
  int backgroundMode = 0;
  // Uploaded company background image (cover-fitted below all layers).
  const uint8_t *backgroundImage = nullptr;
  uint32_t backgroundImageWidth = 0;
  uint32_t backgroundImageHeight = 0;
  uint64_t backgroundImageCacheKey = 0;
  GpuLayerMapping backgroundImageMapping;
  uint64_t frameIndex = 0;
  const VideoFrame *cameraFrame = nullptr;
  GpuLayerMapping camera;
  const uint8_t *cameraMask = nullptr;
  uint32_t maskWidth = 0;
  uint32_t maskHeight = 0;
  uint64_t maskTimestampNs = 0;
  const VideoFrame *backGraphics = nullptr;
  GpuLayerMapping backMapping;
  const VideoFrame *frontGraphics = nullptr;
  GpuLayerMapping frontMapping;
};

}  // namespace broadify::meeting
