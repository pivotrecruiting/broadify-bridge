#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <atomic>

namespace broadify::meeting {

class MeetingRecorder;

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      std::atomic<bool> &running);

}  // namespace broadify::meeting
