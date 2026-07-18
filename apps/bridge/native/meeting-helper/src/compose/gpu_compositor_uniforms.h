#pragma once

#include <cstddef>
#include <cstdint>

namespace broadify::meeting {

// Host-side GPU uniform ABI. MSL and HLSL declarations must match this layout.
struct GpuComposeUniforms {
  uint32_t width;
  uint32_t height;
  uint32_t backgroundMode;
  uint32_t frameIndex96;
  uint32_t cameraPresent;
  uint32_t cameraKeyed;
  uint32_t cameraMirror;
  uint32_t backPresent;
  float camScaleX;
  float camScaleY;
  float camBiasX;
  float camBiasY;
  float camMirrorConst;
  float camTexWidth;
  float camTexHeight;
  float backMirrorConst;
  float backScaleX;
  float backScaleY;
  float backBiasX;
  float backBiasY;
  uint32_t frontPresent;
  float frontScaleX;
  float frontScaleY;
  float frontBiasX;
  float frontBiasY;
  float pad0;
  float pad1;
  float pad2;
  uint32_t maskPresent;
  uint32_t padK0;
  uint32_t padK1;
  uint32_t padK2;
};

static_assert(sizeof(GpuComposeUniforms) == 128u);
static_assert(offsetof(GpuComposeUniforms, maskPresent) == 112u);

}  // namespace broadify::meeting
