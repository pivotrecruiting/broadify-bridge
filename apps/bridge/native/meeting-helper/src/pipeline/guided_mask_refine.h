#pragma once

#include "capture/camera_source.h"
#include "keyer/keyer.h"

namespace broadify::meeting {

// GPU guided-filter edge refinement (macOS / Core Image). Snaps the alpha
// mask's edge to the real edges of the guide camera frame, so the key follows
// the subject sharply, without the temporal lag or edge flicker that mask-only
// smoothing produces on motion. Rewrites `mask` in place (and resizes it to the
// working resolution). No-op when Core Image/Metal is unavailable or inputs are
// empty, so the caller can invoke it unconditionally.
void guidedRefineMask(AlphaMask &mask, const VideoFrame &guideFrame);

// True when the guided-filter backend initialized successfully (for logging).
bool guidedRefineAvailable();

}  // namespace broadify::meeting
