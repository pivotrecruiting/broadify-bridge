#pragma once

#include "live_stream/viewer_types.h"
#include "live_stream/video_encoder.h"
#include "live_stream/audio_packet.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace broadify::live {

struct ViewerStats {
  std::string viewerId;
  std::string state;          // "connecting" | "connected" | "failed" | "closed"
  std::string candidateType;  // "host" | "srflx" | "relay" | ""
  uint64_t createdNs = 0;
  bool audio = false;
};

/**
 * WebRTC publisher: one PeerConnection per viewer, the same encoded stream
 * packetized per connection. The browser offers (recvonly); we answer with a
 * sendonly H.264 track (+ Opus when the offer has audio and we have a source),
 * after ICE gathering completed or the bound elapsed. libdatachannel only.
 */
class WebRtcPublisher {
 public:
  /** `eventType` names the helper event emitted on viewer state changes (e.g. "pgm_viewer_state"). */
  explicit WebRtcPublisher(std::function<void()> onKeyframeRequest, std::string eventType = "pgm_viewer_state");
  ~WebRtcPublisher();

  /** Returns the answer SDP; throws RpcFailure on invalid offers. */
  std::string addViewer(const ViewerOfferRequest &request, bool audioAvailable, uint32_t gatherBoundMs = 3000);
  void removeViewer(const std::string &viewerId);
  void closeAll();

  void sendVideo(const EncodedAccessUnit &unit);
  void sendAudio(const EncodedAudioPacket &packet);

  size_t viewerCount() const;
  std::vector<ViewerStats> stats() const;
  std::string sessionsJson() const;
  /** Removes viewers whose connection failed/closed; returns how many were reaped. */
  size_t reapDead();

 private:
  struct Viewer;
  std::function<void()> onKeyframeRequest_;
  std::string eventType_;
  std::vector<std::shared_ptr<Viewer>> viewers_;
  mutable std::mutex mutex_;
  uint64_t lastVideoPtsUs_ = 0;
};

}  // namespace broadify::live
