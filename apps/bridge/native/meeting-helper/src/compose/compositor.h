#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "state/meeting_state.h"

#include <cstdint>
#include <vector>

namespace broadify::meeting {

struct CompositorSnapshot {
  bool keyerEnabled = false;
  std::string backgroundMode = "transparent";
  SpeakerLayoutState speakerLayout;
  CornerbugState cornerbug;
  MediaLayerState mediaLayer;
  GraphicsState graphics;
  CameraRenderState cameraRender;
};

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state);

void renderProgramFrame(const Options &options,
                        const CompositorSnapshot &snapshot,
                        const VideoFrame *cameraFrame,
                        const VideoFrame *graphicsFrame,
                        uint64_t frameIndex,
                        std::vector<uint8_t> &output);

}  // namespace broadify::meeting
