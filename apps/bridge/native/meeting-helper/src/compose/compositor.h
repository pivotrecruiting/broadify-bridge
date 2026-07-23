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
  bool conferenceMode = false;
  std::string backgroundMode = "transparent";
  std::string backgroundImagePath;
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

// Conference: overlay a second live camera as a picture-in-picture inset on a
// finished program frame (bottom-right). No-op when the PiP frame is empty.
void drawCameraPipInset(std::vector<uint8_t> &output, uint32_t width,
                        uint32_t height, const VideoFrame &pip);

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
