#pragma once

#include "capture/camera_source.h"

#include <cstdint>
#include <vector>

namespace broadify::meeting {

// Maps a destination pixel (center) to a continuous source pixel coordinate:
//   src = (dest + 0.5) * scale + bias
// Used for the camera layer (keyed presenter or full-frame cover) and the
// graphics layers (cover crop). Mirroring is applied in the shader after the
// mapping.
struct MetalLayerMapping {
  bool present = false;
  bool keyed = false;
  bool mirror = false;
  float scaleX = 1.0f;
  float scaleY = 1.0f;
  float biasX = 0.0f;
  float biasY = 0.0f;
  // Mirroring is src' = mirrorConst - src, so it works both for full-texture
  // mirroring (presenter) and mirroring inside a cover-crop rect (camera).
  float mirrorConst = 0.0f;
};

struct MetalComposePlan {
  uint32_t width = 0;
  uint32_t height = 0;
  // 0 dark, 1 gradient (animated), 2 solid_light, 3 checkerboard, 4 transparent
  int backgroundMode = 0;
  uint64_t frameIndex = 0;
  const VideoFrame *cameraFrame = nullptr;
  MetalLayerMapping camera;
  const VideoFrame *backGraphics = nullptr;
  MetalLayerMapping backMapping;
  const VideoFrame *frontGraphics = nullptr;
  MetalLayerMapping frontMapping;
};

// True when the GPU compositor is available and not disabled via
// BROADIFY_MEETING_GPU_COMPOSITOR=0.
bool metalCompositorAvailable();

// Composites background + back graphics + camera layer + front graphics on
// the GPU into `output` (RGBA, width*height*4). Returns false on any failure;
// callers must then render through the CPU compositor instead.
bool renderProgramFrameMetal(const MetalComposePlan &plan, std::vector<uint8_t> &output);

}  // namespace broadify::meeting
