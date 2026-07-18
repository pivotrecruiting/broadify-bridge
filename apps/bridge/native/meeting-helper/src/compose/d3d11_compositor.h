#pragma once

#include "compose/gpu_compositor_types.h"
#include "keyer/keyer.h"

namespace broadify::meeting {

// True when the D3D11 GPU compositor is available. It is enabled by default;
// BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0 forces the CPU fallback.
bool d3d11CompositorAvailable();

// Initializes the compositor for a self-test and permits the explicit WARP
// driver override. Normal runtime initialization ignores that override.
bool d3d11CompositorSelfTestAvailable();

// True when the initialized D3D11 compositor uses a hardware device rather
// than the explicit self-test-only WARP device.
bool d3d11CompositorHardwareAccelerated();

// Composites the shared GPU compose plan (background + graphics + keyed
// camera) on the GPU into `output` (RGBA, width*height*4).
// Returns false on any failure; callers must then render through the CPU
// compositor instead.
bool renderProgramFrameD3D11(const GpuComposePlan &plan,
                             std::vector<uint8_t> &output);

// True when the D3D11 guided mask refine is available. It is enabled by
// default; BROADIFY_MEETING_GPU_GUIDED=0 forces the portable CPU fallback.
bool d3d11GuidedRefineAvailable();

// GPU port of guidedRefineMask (guided_mask_refine.cpp): snaps the mask onto
// the guide frame's luma edges on a <=512-wide working grid and REPLACES the
// mask with the working-resolution result, with identical semantics to the CPU
// path. Returns false on any failure; callers must then run the CPU refine.
bool guidedRefineMaskD3D11(AlphaMask &mask, const VideoFrame &guideFrame);

}  // namespace broadify::meeting
