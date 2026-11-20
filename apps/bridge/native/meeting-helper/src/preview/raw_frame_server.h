#pragma once

#include "preview/preview_frame_store.h"
#include "preview/raw_frame_stream_header.h"
#include "state/meeting_state.h"

#include <atomic>
#include <cstdint>
#include <vector>

namespace broadify::meeting {

/**
 * Serves the latest program frame as a local raw RGBA debug/VCam stream.
 * `geometry` is the configured program size/fps; it is advertised in the HTTP
 * handshake so clients can negotiate their output format before the first
 * frame arrives (see buildRawFrameStreamHeader).
 *
 * The virtual camera only takes 16:9: for a portrait program (height > width)
 * both the advertised geometry and every frame record are 1920x1080 with the
 * program pillarboxed (vcamOutputGeometry / fitContainRgba in
 * util/frame_fit.h). Landscape programs are passed through unchanged.
 */
void runRawFrameServer(uint16_t port,
                       RawFrameStreamGeometry geometry,
                       PreviewFrameStore &previewFrames,
                       MeetingState &state,
                       std::atomic<bool> &running);

std::vector<bool> reapCompletedRawFrameWorkers(
    const std::vector<bool> &workerCompleted);

}  // namespace broadify::meeting
