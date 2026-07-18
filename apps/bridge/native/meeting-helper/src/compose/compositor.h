#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "keyer/keyer.h"
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

struct GpuCompositorSelfTestResult {
  bool available = false;
  bool passed = false;
  bool hardwareAccelerated = false;
  int maxChannelDelta = -1;
  uint32_t maxDeltaX = 0u;
  uint32_t maxDeltaY = 0u;
  uint32_t maxDeltaChannel = 0u;
  uint8_t maxDeltaCpuValue = 0u;
  uint8_t maxDeltaGpuValue = 0u;
  std::string backend = "cpu";
};

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state);

std::string renderProgramFrame(const Options &options,
                               const CompositorSnapshot &snapshot,
                               const VideoFrame *cameraFrame,
                               const AlphaMask *cameraMask,
                               const VideoFrame *backGraphicsFrame,
                               const VideoFrame *frontGraphicsFrame,
                               uint64_t frameIndex,
                               std::vector<uint8_t> &output);

GpuCompositorSelfTestResult runGpuCompositorSelfTest();

}  // namespace broadify::meeting
