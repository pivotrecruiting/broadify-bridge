#pragma once

#include "live_stream/viewer_types.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace broadify::meeting {

class PreviewFrameStore;
struct MeetingState;

struct ProgramStreamConfig {
  uint32_t width = 1920;
  uint32_t height = 1080;
  uint32_t fps = 30;
};

/**
 * WebRTC stream of the composited program (the picture the virtual camera and
 * the recorder get): hardware H.264 + libdatachannel from the shared
 * live_stream library, one PeerConnection per viewer, answering browser
 * offers the bridge relays (`program.viewer.offer`).
 *
 * Runs on its own thread and pulls frames from PreviewFrameStore, so the
 * frame pipeline (and with it the virtual camera and the recording) never
 * waits for the encoder: without viewers nothing is copied or encoded; with
 * viewers each new program frame is converted RGBA→BGRA into a pooled,
 * IOSurface-backed CVPixelBuffer in one pass and handed to VideoToolbox,
 * which encodes asynchronously. A frame the encoder cannot take is dropped,
 * never queued. Viewer state changes are emitted as `meeting_viewer_state`
 * helper events. Unsupported (stub) on platforms without the hardware
 * encoder path: every offer fails with `program_stream_unavailable`.
 */
class ProgramStream {
 public:
  ProgramStream(PreviewFrameStore &frames, MeetingState &state, ProgramStreamConfig config);
  ~ProgramStream();
  ProgramStream(const ProgramStream &) = delete;
  ProgramStream &operator=(const ProgramStream &) = delete;

  void start();
  void stop();

  bool supported() const;
  /** Answer SDP for a recvonly browser offer; throws live::RpcFailure. */
  std::string viewerOffer(const live::ViewerOfferRequest &request);
  void viewerClose(const std::string &viewerId);
  size_t viewerCount() const;
  /** JSON array of live viewers (id, state, candidate type, age). */
  std::string sessionsJson() const;
  /** JSON object: supported, active, viewers, encoder, frame counters. */
  std::string statusJson() const;

  struct Impl;

 private:
  Impl *impl_;
};

}  // namespace broadify::meeting
