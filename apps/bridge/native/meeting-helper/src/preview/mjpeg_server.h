#pragma once

#include <atomic>
#include <cstdint>

namespace broadify::meeting {

class PreviewFrameStore;
struct MeetingState;

void runMjpegServer(uint16_t port,
                    PreviewFrameStore &previewFrames,
                    MeetingState &state,
                    std::atomic<bool> &running);

}  // namespace broadify::meeting
