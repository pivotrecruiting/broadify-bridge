// In-process loopback: a libdatachannel "browser" offers a recvonly video
// (+audio) section, the publisher answers, ICE connects over loopback and the
// receiver sees RTP for a synthetic IDR access unit. Exercises the real
// answer path (mid/payload-type mirroring, SSRC, packetizer chain).
#include "webrtc/publisher.h"

#include <rtc/rtc.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "webrtc_loopback_test failed: " << m << std::endl; std::exit(1); }

int main() {
  rtc::InitLogger(rtc::LogLevel::Warning);
  std::atomic<int> keyframeRequests{0};
  WebRtcPublisher publisher([&]() { keyframeRequests.fetch_add(1); });

  rtc::Configuration config;
  auto browser = std::make_shared<rtc::PeerConnection>(config);
  rtc::Description::Video video("0", rtc::Description::Direction::RecvOnly);
  video.addH264Codec(96, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f");
  auto videoTrack = browser->addTrack(video);
  rtc::Description::Audio audio("1", rtc::Description::Direction::RecvOnly);
  audio.addOpusCodec(111);
  auto audioTrack = browser->addTrack(audio);

  std::mutex mutex;
  std::condition_variable cv;
  bool gathered = false;
  browser->onGatheringStateChange([&](rtc::PeerConnection::GatheringState state) {
    if (state == rtc::PeerConnection::GatheringState::Complete) {
      std::lock_guard<std::mutex> lock(mutex);
      gathered = true;
      cv.notify_all();
    }
  });
  std::atomic<int> rtpPackets{0};
  videoTrack->onMessage([&](rtc::message_variant) { rtpPackets.fetch_add(1); });
  browser->setLocalDescription();
  {
    std::unique_lock<std::mutex> lock(mutex);
    if (!cv.wait_for(lock, std::chrono::seconds(5), [&]() { return gathered; })) fail("browser gathering timeout");
  }
  auto offer = browser->localDescription();
  if (!offer) fail("no offer");

  ViewerOfferRequest request;
  request.viewerId = "viewer-1";
  request.sdp = std::string(*offer);
  request.profile = "lan";
  const std::string answer = publisher.addViewer(request, true, 3000);
  if (answer.find("a=sendonly") == std::string::npos) fail("answer is not sendonly");
  if (answer.find("H264/90000") == std::string::npos) fail("answer lacks H264");
  if (answer.find("opus/48000") == std::string::npos) fail("answer lacks opus");
  if (keyframeRequests.load() < 1) fail("no keyframe requested for the new viewer");
  browser->setRemoteDescription(rtc::Description(answer, rtc::Description::Type::Answer));

  // Wait for the connection, then push a few synthetic IDR access units.
  for (int i = 0; i < 100 && browser->state() != rtc::PeerConnection::State::Connected; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (browser->state() != rtc::PeerConnection::State::Connected) fail("peer connection did not connect over loopback");
  for (int i = 0; i < 100 && !videoTrack->isOpen(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (!videoTrack->isOpen()) fail("video track did not open");
  if (publisher.viewerCount() != 1) fail("viewer count");

  EncodedAccessUnit unit;
  unit.keyframe = true;
  unit.annexB = {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22};
  unit.annexB.resize(unit.annexB.size() + 3000, 0x33);  // beyond one MTU -> FU-A fragmentation
  for (int i = 0; i < 10; ++i) {
    unit.captureNs = static_cast<uint64_t>(i) * 16'666'667ULL;
    publisher.sendVideo(unit);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  for (int i = 0; i < 100 && rtpPackets.load() < 10; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (rtpPackets.load() < 10) fail("receiver saw too few RTP packets");

  const std::string sessions = publisher.sessionsJson();
  if (sessions.find("\"viewer_id\":\"viewer-1\"") == std::string::npos || sessions.find("\"state\":\"connected\"") == std::string::npos) fail("sessions json");
  publisher.removeViewer("viewer-1");
  if (publisher.viewerCount() != 0) fail("viewer not removed");
  browser->close();
  std::cout << "webrtc_loopback_test passed (rtp packets: " << rtpPackets.load() << ")" << std::endl;
  return 0;
}
