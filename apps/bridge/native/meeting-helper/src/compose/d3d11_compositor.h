#pragma once

#include "compose/metal_compositor.h"
#include "keyer/keyer.h"

namespace broadify::meeting {

// True when the D3D11 GPU compositor is available AND explicitly enabled via
// BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=1 (default OFF while the Windows path
// is being validated). Callers fall back to the CPU compositor otherwise.
bool d3d11CompositorAvailable();

// Composites the shared GPU compose plan (background + graphics + keyed
// camera + media layer) on the GPU into `output` (RGBA, width*height*4).
// Returns false on any failure; callers must then render through the CPU
// compositor instead.
bool renderProgramFrameD3D11(const MetalComposePlan &plan,
                             std::vector<uint8_t> &output);

// True when the D3D11 guided mask refine is available AND explicitly enabled
// via BROADIFY_MEETING_GPU_GUIDED=1 (default OFF). Independent kill-switch
// from the compositor so the two stages can be validated separately.
bool d3d11GuidedRefineAvailable();

// GPU port of guidedRefineMask (guided_mask_refine.cpp): snaps the mask onto
// the guide frame's luma edges on a <=512-wide working grid and REPLACES the
// mask with the working-resolution result — identical semantics to the CPU
// path. Returns false on any failure; callers must then run the CPU refine.
bool guidedRefineMaskD3D11(AlphaMask &mask, const VideoFrame &guideFrame);

}  // namespace broadify::meeting
