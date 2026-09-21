#pragma once

#include "compose/metal_compositor.h"
#include "keyer/keyer.h"

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

// True when the D3D11 GPU compositor is available AND not disabled. Default
// ON; the kill-switch BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0 forces the CPU
// compositor. Callers fall back to the CPU compositor when this is false.
bool d3d11CompositorAvailable();

// Composites the shared GPU compose plan (background + graphics + keyed
// camera + media layer) on the GPU into `output` (RGBA, width*height*4).
// Returns false on any failure; callers must then render through the CPU
// compositor instead.
bool renderProgramFrameD3D11(const MetalComposePlan &plan,
                             std::vector<uint8_t> &output);

// True when the D3D11 guided mask refine is available AND not disabled.
// Default ON; the kill-switch BROADIFY_MEETING_GPU_GUIDED=0 forces the CPU
// guided filter. Independent kill-switch from the compositor so the two
// stages can be validated separately.
bool d3d11GuidedRefineAvailable();

// GPU port of guidedRefineMask (guided_mask_refine.cpp): snaps the mask onto
// the guide frame's luma edges on a <=512-wide working grid and REPLACES the
// mask with the working-resolution result — identical semantics to the CPU
// path. Returns false on any failure; callers must then run the CPU refine.
bool guidedRefineMaskD3D11(AlphaMask &mask, const VideoFrame &guideFrame);

void resetGuidedRefineD3D11History();

uint64_t d3d11CompositorCameraUploadCount();

double d3d11CompositorCameraUploadMs();

uint32_t d3d11CompositorStagingReadbackDepth();

std::string d3d11CompositorAdapterStatus();

}  // namespace broadify::meeting
