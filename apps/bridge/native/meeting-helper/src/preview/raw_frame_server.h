#pragma once

#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <atomic>
#include <cstdint>

namespace broadify::meeting {

/** Serves the latest program frame as a local raw RGBA debug/VCam stream. */
void runRawFrameServer(uint16_t port,
                       PreviewFrameStore &previewFrames,
                       MeetingState &state,
                       std::atomic<bool> &running);

}  // namespace broadify::meeting
