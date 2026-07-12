#pragma once

#include "capture/camera_source.h"
#include "keyer/keyer.h"
#include "common/options.h"
#include "state/meeting_state.h"

#include <cstdint>
#include <vector>

namespace broadify::meeting {

struct CompositorSnapshot {
  bool keyerEnabled = false;
  std::string backgroundMode = "transparent";
  std::string backgroundImagePath;
  SpeakerLayoutState speakerLayout;
  CornerbugState cornerbug;
  MediaLayerState mediaLayer;
  GraphicsState graphics;
  CameraRenderState cameraRender;
};

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state);

// Which backend rendered the most recent program frame ("cpu", "d3d11",
// "metal"). Written by the program-loop thread inside renderProgramFrame.
const char *lastCompositorBackend();

// cameraMask: alpha mask belonging to cameraFrame (nullptr for passthrough).
// The mask is applied during compositing (GPU shader or CPU fallback);
// camera frames arrive unkeyed.
// cameraPipFrame: an optional second live camera drawn as a picture-in-picture
// inset (nullptr = no camera PiP). Conference uses it for a second angle.
void renderProgramFrame(const Options &options,
                        const CompositorSnapshot &snapshot,
                        const VideoFrame *cameraFrame,
                        const AlphaMask *cameraMask,
                        const VideoFrame *backGraphicsFrame,
                        const VideoFrame *frontGraphicsFrame,
                        const VideoFrame *cameraPipFrame,
                        uint64_t frameIndex,
                        std::vector<uint8_t> &output);

}  // namespace broadify::meeting
