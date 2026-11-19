#include "live_stream/publisher.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#include <rtc/rtc.hpp>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <random>

namespace broadify::live {

using broadify::helper::emitHelperEvent;
using broadify::helper::jsonEscape;

namespace {

constexpr uint32_t OPUS_CLOCK_RATE = 48000;

uint64_t steadyNs() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
}

uint32_t randomSsrc() {
  static std::mt19937 rng{std::random_device{}()};
  return std::uniform_int_distribution<uint32_t>(1000, 0x7fffffff)(rng);
}

std::string stateName(rtc::PeerConnection::State state) {
  switch (state) {
    case rtc::PeerConnection::State::New: return "new";
    case rtc::PeerConnection::State::Connecting: return "connecting";
    case rtc::PeerConnection::State::Connected: return "connected";
    case rtc::PeerConnection::State::Disconnected: return "disconnected";
    case rtc::PeerConnection::State::Failed: return "failed";
    case rtc::PeerConnection::State::Closed: return "closed";
  }
  return "unknown";
}

/** Payload type of the best H.264 entry in the offered media (packetization-mode=1 preferred). */
int pickH264PayloadType(const rtc::Description::Media &media, std::string &fmtpOut) {
  int fallback = -1;
  for (int pt : media.payloadTypes()) {
    const rtc::Description::Media::RtpMap *map = media.rtpMap(pt);
    if (map == nullptr || map->format != "H264") {
      continue;
    }
    std::string fmtp;
    for (const std::string &f : map->fmtps) {
      fmtp += f;
    }
    if (fmtp.find("packetization-mode=1") != std::string::npos) {
      fmtpOut = fmtp;
      return pt;
    }
    if (fallback < 0) {
      fallback = pt;
      fmtpOut = fmtp;
    }
  }
  return fallback;
}

int pickOpusPayloadType(const rtc::Description::Media &media) {
  for (int pt : media.payloadTypes()) {
    const rtc::Description::Media::RtpMap *map = media.rtpMap(pt);
    if (map != nullptr && map->format == "opus") {
      return pt;
    }
  }
  return -1;
}

}  // namespace

struct WebRtcPublisher::Viewer {
  std::string id;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> video;
  std::shared_ptr<rtc::Track> audio;
  std::shared_ptr<rtc::RtpPacketizationConfig> videoConfig;
  std::shared_ptr<rtc::RtpPacketizationConfig> audioConfig;
  std::string state = "connecting";
  uint64_t createdNs = 0;
  bool hasAudio = false;
  bool videoOpen = false;
  bool audioOpen = false;
};

WebRtcPublisher::WebRtcPublisher(std::function<void()> onKeyframeRequest, std::string eventType)
    : onKeyframeRequest_(std::move(onKeyframeRequest)), eventType_(std::move(eventType)) {
  rtc::InitLogger(rtc::LogLevel::Warning);
}

WebRtcPublisher::~WebRtcPublisher() { closeAll(); }

std::string WebRtcPublisher::addViewer(const ViewerOfferRequest &request, bool audioAvailable, uint32_t gatherBoundMs) {
  rtc::Configuration config;
  for (const IceServerSpec &spec : request.iceServers) {
    try {
      if (spec.username.empty()) {
        config.iceServers.emplace_back(spec.url);
      } else {
        // libdatachannel parses "turn:user:pass@host:port?transport=udp"; build that form.
        std::string url = spec.url;
        const size_t scheme = url.find(':');
        if (scheme != std::string::npos) {
          url = url.substr(0, scheme + 1) + spec.username + ":" + spec.credential + "@" + url.substr(scheme + 1);
        }
        config.iceServers.emplace_back(url);
      }
    } catch (const std::exception &error) {
      throw RpcFailure{"pgm_sdp_invalid", std::string("Invalid ICE server: ") + error.what()};
    }
  }
  config.disableAutoNegotiation = true;

  std::unique_ptr<rtc::Description> offer;
  try {
    offer = std::make_unique<rtc::Description>(request.sdp, rtc::Description::Type::Offer);
  } catch (const std::exception &error) {
    throw RpcFailure{"pgm_sdp_invalid", std::string("Offer could not be parsed: ") + error.what()};
  }

  auto viewer = std::make_shared<Viewer>();
  viewer->id = request.viewerId;
  viewer->createdNs = steadyNs();
  viewer->pc = std::make_shared<rtc::PeerConnection>(config);
  std::weak_ptr<Viewer> weak = viewer;

  // Mirror every offered media section with a sendonly track of ours (same mid, same payload types).
  bool haveVideo = false;
  for (int i = 0; i < offer->mediaCount(); ++i) {
    auto section = offer->media(i);
    const rtc::Description::Media *media = std::get_if<rtc::Description::Media *>(&section) ? *std::get_if<rtc::Description::Media *>(&section) : nullptr;
    if (media == nullptr) {
      continue;
    }
    if (media->type() == "video" && !haveVideo) {
      std::string fmtp;
      const int pt = pickH264PayloadType(*media, fmtp);
      if (pt < 0) {
        throw RpcFailure{"pgm_sdp_invalid", "The offer has no H.264 payload type."};
      }
      rtc::Description::Video video(media->mid(), rtc::Description::Direction::SendOnly);
      video.addH264Codec(pt, fmtp.empty() ? std::nullopt : std::optional<std::string>(fmtp));
      const uint32_t ssrc = randomSsrc();
      video.addSSRC(ssrc, "broadify-pgm", "pgm", "pgm-video");
      viewer->video = viewer->pc->addTrack(video);
      viewer->videoConfig = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, "broadify-pgm", static_cast<uint8_t>(pt), rtc::H264RtpPacketizer::defaultClockRate);
      auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, viewer->videoConfig);
      packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(viewer->videoConfig));
      packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
      packetizer->addToChain(std::make_shared<rtc::PliHandler>([this]() {
        if (onKeyframeRequest_) {
          onKeyframeRequest_();
        }
      }));
      viewer->video->setMediaHandler(packetizer);
      viewer->video->onOpen([weak]() {
        if (auto v = weak.lock()) {
          v->videoOpen = true;
        }
      });
      haveVideo = true;
    } else if (media->type() == "audio" && audioAvailable && !viewer->hasAudio) {
      const int pt = pickOpusPayloadType(*media);
      if (pt < 0) {
        continue;
      }
      rtc::Description::Audio audio(media->mid(), rtc::Description::Direction::SendOnly);
      audio.addOpusCodec(pt);
      const uint32_t ssrc = randomSsrc();
      audio.addSSRC(ssrc, "broadify-pgm", "pgm", "pgm-audio");
      viewer->audio = viewer->pc->addTrack(audio);
      viewer->audioConfig = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, "broadify-pgm", static_cast<uint8_t>(pt), OPUS_CLOCK_RATE);
      auto packetizer = std::make_shared<rtc::OpusRtpPacketizer>(viewer->audioConfig);
      packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(viewer->audioConfig));
      viewer->audio->setMediaHandler(packetizer);
      viewer->audio->onOpen([weak]() {
        if (auto v = weak.lock()) {
          v->audioOpen = true;
        }
      });
      viewer->hasAudio = true;
    }
  }
  if (!haveVideo) {
    throw RpcFailure{"pgm_sdp_invalid", "The offer has no video section."};
  }

  std::mutex gatherMutex;
  std::condition_variable gatherCv;
  bool gathered = false;
  viewer->pc->onGatheringStateChange([&](rtc::PeerConnection::GatheringState state) {
    if (state == rtc::PeerConnection::GatheringState::Complete) {
      std::lock_guard<std::mutex> lock(gatherMutex);
      gathered = true;
      gatherCv.notify_all();
    }
  });
  const std::string viewerId = request.viewerId;
  const std::string eventType = eventType_;
  viewer->pc->onStateChange([weak, viewerId, eventType](rtc::PeerConnection::State state) {
    if (auto v = weak.lock()) {
      v->state = stateName(state);
    }
    emitHelperEvent("{\"type\":\"" + eventType + "\",\"viewer_id\":\"" + jsonEscape(viewerId) + "\",\"state\":\"" + stateName(state) + "\"}");
  });

  try {
    viewer->pc->setRemoteDescription(*offer);
    viewer->pc->setLocalDescription(rtc::Description::Type::Answer);
  } catch (const std::exception &error) {
    throw RpcFailure{"pgm_sdp_invalid", std::string("Answer failed: ") + error.what()};
  }
  {
    std::unique_lock<std::mutex> lock(gatherMutex);
    gatherCv.wait_for(lock, std::chrono::milliseconds(gatherBoundMs), [&]() { return gathered; });
  }
  viewer->pc->onGatheringStateChange([](rtc::PeerConnection::GatheringState) {});
  auto local = viewer->pc->localDescription();
  if (!local) {
    throw RpcFailure{"pgm_sdp_invalid", "No local description after answering."};
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    viewers_.erase(std::remove_if(viewers_.begin(), viewers_.end(), [&](const std::shared_ptr<Viewer> &v) { return v->id == request.viewerId; }), viewers_.end());
    viewers_.push_back(viewer);
  }
  if (onKeyframeRequest_) {
    onKeyframeRequest_();
  }
  return std::string(*local);
}

void WebRtcPublisher::removeViewer(const std::string &viewerId) {
  std::shared_ptr<Viewer> victim;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = std::find_if(viewers_.begin(), viewers_.end(), [&](const std::shared_ptr<Viewer> &v) { return v->id == viewerId; });
    if (it == viewers_.end()) {
      return;
    }
    victim = *it;
    viewers_.erase(it);
  }
  victim->pc->close();
}

void WebRtcPublisher::closeAll() {
  std::vector<std::shared_ptr<Viewer>> all;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    all.swap(viewers_);
  }
  for (auto &viewer : all) {
    viewer->pc->close();
  }
}

void WebRtcPublisher::sendVideo(const EncodedAccessUnit &unit) {
  std::vector<std::shared_ptr<Viewer>> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = viewers_;
  }
  const double seconds = static_cast<double>(unit.captureNs) / 1e9;
  for (auto &viewer : snapshot) {
    if (!viewer->video || !viewer->videoOpen || !viewer->video->isOpen()) {
      continue;
    }
    viewer->videoConfig->timestamp = viewer->videoConfig->secondsToTimestamp(seconds);
    try {
      viewer->video->send(reinterpret_cast<const std::byte *>(unit.annexB.data()), unit.annexB.size());
    } catch (const std::exception &) {
      // Send failures surface via the connection state; never stall the encoder thread.
    }
  }
}

void WebRtcPublisher::sendAudio(const EncodedAudioPacket &packet) {
  std::vector<std::shared_ptr<Viewer>> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = viewers_;
  }
  const double seconds = static_cast<double>(packet.captureNs) / 1e9;
  for (auto &viewer : snapshot) {
    if (!viewer->audio || !viewer->audioOpen || !viewer->audio->isOpen()) {
      continue;
    }
    viewer->audioConfig->timestamp = viewer->audioConfig->secondsToTimestamp(seconds);
    try {
      viewer->audio->send(reinterpret_cast<const std::byte *>(packet.opus.data()), packet.opus.size());
    } catch (const std::exception &) {
    }
  }
}

size_t WebRtcPublisher::viewerCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return viewers_.size();
}

std::vector<ViewerStats> WebRtcPublisher::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<ViewerStats> out;
  for (const auto &viewer : viewers_) {
    ViewerStats s;
    s.viewerId = viewer->id;
    s.state = viewer->state;
    s.createdNs = viewer->createdNs;
    s.audio = viewer->hasAudio;
    rtc::Candidate local;
    rtc::Candidate remote;
    if (viewer->pc->getSelectedCandidatePair(&local, &remote)) {
      switch (local.type()) {
        case rtc::Candidate::Type::Host: s.candidateType = "host"; break;
        case rtc::Candidate::Type::ServerReflexive: s.candidateType = "srflx"; break;
        case rtc::Candidate::Type::PeerReflexive: s.candidateType = "prflx"; break;
        case rtc::Candidate::Type::Relayed: s.candidateType = "relay"; break;
        default: break;
      }
    }
    out.push_back(s);
  }
  return out;
}

std::string WebRtcPublisher::sessionsJson() const {
  std::string json = "[";
  bool first = true;
  for (const ViewerStats &s : stats()) {
    json += (first ? "" : ",");
    json += "{\"viewer_id\":\"" + jsonEscape(s.viewerId) + "\",\"state\":\"" + jsonEscape(s.state) + "\",\"candidate_type\":\"" +
            jsonEscape(s.candidateType) + "\",\"audio\":" + (s.audio ? "true" : "false") + ",\"age_ms\":" +
            std::to_string((steadyNs() - s.createdNs) / 1'000'000ULL) + "}";
    first = false;
  }
  return json + "]";
}

size_t WebRtcPublisher::reapDead() {
  std::vector<std::shared_ptr<Viewer>> dead;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t now = steadyNs();
    auto it = std::remove_if(viewers_.begin(), viewers_.end(), [&](const std::shared_ptr<Viewer> &v) {
      const bool failed = v->state == "failed" || v->state == "closed";
      const bool neverConnected = v->state == "connecting" && now - v->createdNs > 15'000'000'000ULL;
      const bool stale = v->state == "disconnected" && now - v->createdNs > 10'000'000'000ULL;
      if (failed || neverConnected || stale) {
        dead.push_back(v);
        return true;
      }
      return false;
    });
    viewers_.erase(it, viewers_.end());
  }
  for (auto &viewer : dead) {
    viewer->pc->close();
  }
  return dead.size();
}

}  // namespace broadify::live
