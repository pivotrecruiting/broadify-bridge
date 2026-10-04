#pragma once

#include "capture/camera_source.h"
#include "capture/screen_capture_source.h"
#include "common/options.h"
#include "state/meeting_state.h"

#include <atomic>
#include <functional>
#include <string>

namespace broadify::meeting {

class PreviewFrameStore;
class MeetingRecorder;
class VcamShmRingWin;

std::string handleRpc(const std::string &line,
                      MeetingState &state,
                      CameraSource &camera,
                      ScreenCaptureSource &screen,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      VcamShmRingWin *vcamShm,
                      const Options &options,
                      std::atomic<bool> &running);

void runControlServer(const std::string &socketPath,
                      MeetingState &state,
                      CameraSource &camera,
                      ScreenCaptureSource &screen,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      const Options &options,
                      std::atomic<bool> &running,
                      const std::function<void()> &onListening = {},
                      VcamShmRingWin *vcamShm = nullptr);

}  // namespace broadify::meeting
