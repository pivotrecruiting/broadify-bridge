#pragma once

#include "compose/gpu_compositor_types.h"

#include <vector>

namespace broadify::meeting {

// True when the GPU compositor is available and not disabled via
// BROADIFY_MEETING_GPU_COMPOSITOR=0.
bool metalCompositorAvailable();

// Composites background + back graphics + camera layer + front graphics on
// the GPU into `output` (RGBA, width*height*4). Returns false on any failure;
// callers must then render through the CPU compositor instead.
bool renderProgramFrameMetal(const GpuComposePlan &plan, std::vector<uint8_t> &output);

}  // namespace broadify::meeting
