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

// Media (PiP/fullscreen) layer: the fitted, rotated (perspective) image quad
// is described by an inverse homography mapping destination pixels to image
// UV coordinates in [0,1]. The optional drop shadow is a second quad.
struct MetalMediaLayer {
  bool present = false;
  // Keyed scenes draw the media below the presenter, plain camera scenes
  // draw it above the camera.
  bool belowCamera = false;
  bool shadowPresent = false;
  const uint8_t *rgba = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  // Cache key for texture uploads (image identity; media images are cached
  // CPU-side and only change on program updates).
  uint64_t cacheKey = 0;
  float invHomography[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  float shadowInvHomography[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
};

struct MetalComposePlan {
  MetalMediaLayer media;
  // Uploaded company background image (cover-fitted below all layers).
  const uint8_t *backgroundImage = nullptr;
  uint32_t backgroundImageWidth = 0;
  uint32_t backgroundImageHeight = 0;
  uint64_t backgroundImageCacheKey = 0;
  MetalLayerMapping backgroundImageMapping;
  uint32_t width = 0;
  uint32_t height = 0;
  // 0 dark, 1 gradient (animated), 2 solid_light, 3 checkerboard, 4 transparent
  int backgroundMode = 0;
  uint64_t frameIndex = 0;
  const VideoFrame *cameraFrame = nullptr;
  MetalLayerMapping camera;
  // Keyer mask (R8, stretched over the camera frame); applied in the shader.
  const uint8_t *cameraMask = nullptr;
  uint32_t maskWidth = 0;
  uint32_t maskHeight = 0;
  uint64_t maskTimestampNs = 0;
  // Optional: a pre-made GPU mask texture ((__bridge void *)id<MTLTexture>,
  // single-channel, [0,1]) from the fused GPU path — used directly instead of
  // uploading cameraMask when set, so the mask never round-trips through the CPU.
  const void *maskTextureHandle = nullptr;
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
