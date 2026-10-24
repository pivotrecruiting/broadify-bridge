#pragma once

#include "live_stream/audio_packet.h"
#include "live_stream/video_frame.h"
#include "live_stream/viewer_offer_parse.h"
#include "live_stream/viewer_types.h"

/**
 * The encoder, WebRTC publisher and their value types live in the shared
 * `live_stream` library (apps/bridge/native/live-stream, namespace
 * broadify::live), used by this helper and by the meeting helper. Making them
 * visible in broadify::pgm keeps the engine code free of qualification noise.
 */
namespace broadify::pgm {
using namespace ::broadify::live;  // NOLINT(google-build-using-namespace)
}
