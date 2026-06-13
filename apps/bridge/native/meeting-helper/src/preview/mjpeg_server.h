#pragma once

#include <atomic>
#include <cstdint>

namespace broadify::meeting {

class PreviewFrameStore;

void runMjpegServer(uint16_t port, PreviewFrameStore &previewFrames, std::atomic<bool> &running);

}  // namespace broadify::meeting
