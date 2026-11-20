// Regression for the program stream worker spinning on a cleared
// PreviewFrameStore. `camera.stop` and `output.vcam.raw.stop` clear the store:
// its sequence moves on, but there is no frame to take. With a viewer
// registered the worker then went round its loop without a pause - a full
// core - until the next frame was published.
//
// Drives the real ProgramStream. The viewer does not have to connect: the
// worker serves it from the moment its offer is answered (the publisher drops
// a viewer that never connected after 15 s, long after this test is done).
// The check is the CPU time of the whole process while the store is cleared.
// An idle process uses next to none, however loaded the machine is (measured:
// 0.2 % of the wall time, also next to 30 busy loops on 10 cores), so the test
// cannot fail because of load. A spinning worker uses all it gets: 99 % on an
// idle machine, 20 % next to those 30 busy loops. The limit is 5 %.
#include "live/program_stream.h"

#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <rtc/rtc.hpp>

#include <sys/resource.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using broadify::live::RpcFailure;
using broadify::live::ViewerOfferRequest;
using broadify::meeting::MeetingState;
using broadify::meeting::PreviewFrameStore;
using broadify::meeting::ProgramStream;
using broadify::meeting::ProgramStreamConfig;

namespace {

constexpr uint32_t kWidth = 1280;
constexpr uint32_t kHeight = 720;
constexpr double kMaxIdleCpuShare = 0.05;

[[noreturn]] void fail(const std::string &message) {
  std::cerr << "program_stream_idle_test failed: " << message << std::endl;
  // No unwinding: worker, encoder and libdatachannel threads are still running.
  std::_Exit(1);
}

bool waitFor(const std::function<bool()> &condition, int timeoutMs) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (!condition()) {
    if (std::chrono::steady_clock::now() > deadline) {
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return true;
}

double processCpuSeconds() {
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  return static_cast<double>(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) +
         static_cast<double>(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6;
}

/** CPU time of the process as a share of the wall time over `milliseconds`. */
double cpuShareOver(int milliseconds) {
  const double cpuBefore = processCpuSeconds();
  const auto wallBefore = std::chrono::steady_clock::now();
  std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
  const double cpu = processCpuSeconds() - cpuBefore;
  const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - wallBefore).count();
  return wall > 0.0 ? cpu / wall : 0.0;
}

/** Frames the worker took out of the store so far: encoded, or dropped (e.g. without a hardware encoder). */
uint64_t handledFrames(const ProgramStream &stream) {
  const std::string status = stream.statusJson();
  uint64_t sum = 0;
  for (const char *key : {"\"encoded_frames\":", "\"dropped_frames\":"}) {
    const size_t at = status.find(key);
    if (at == std::string::npos) {
      fail("unexpected status: " + status);
    }
    sum += std::strtoull(status.c_str() + at + std::string(key).size(), nullptr, 10);
  }
  return sum;
}

int consumerCount(MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.programStreamClientCount;
}

/** An offer the way the web app's viewer makes it: one recvonly H.264 section, candidates gathered. */
std::string viewerOfferSdp(const std::shared_ptr<rtc::PeerConnection> &browser) {
  rtc::Description::Video video("0", rtc::Description::Direction::RecvOnly);
  video.addH264Codec(96, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f");
  const auto track = browser->addTrack(video);
  auto gathered = std::make_shared<std::promise<void>>();
  auto once = std::make_shared<std::atomic<bool>>(false);
  browser->onGatheringStateChange([gathered, once](rtc::PeerConnection::GatheringState state) {
    if (state == rtc::PeerConnection::GatheringState::Complete && !once->exchange(true)) {
      gathered->set_value();
    }
  });
  browser->setLocalDescription();
  if (gathered->get_future().wait_for(std::chrono::seconds(10)) != std::future_status::ready) {
    fail("ICE gathering of the offer did not finish");
  }
  const auto description = browser->localDescription();
  if (!description) {
    fail("no offer");
  }
  return std::string(*description);
}

void publishFrames(PreviewFrameStore &frames, const std::vector<uint8_t> &rgba, int count) {
  for (int i = 0; i < count; ++i) {
    frames.publish(kWidth, kHeight, rgba.data(), rgba.size());
    std::this_thread::sleep_for(std::chrono::milliseconds(33));
  }
}

}  // namespace

int main() {
  rtc::InitLogger(rtc::LogLevel::Warning);
  MeetingState state;
  PreviewFrameStore frames;
  ProgramStream stream(frames, state, ProgramStreamConfig{kWidth, kHeight, 30});
  stream.start();

  rtc::Configuration config;
  const auto browser = std::make_shared<rtc::PeerConnection>(config);
  ViewerOfferRequest request;
  request.viewerId = "idle-viewer";
  request.sdp = viewerOfferSdp(browser);
  request.profile = "lan";
  try {
    stream.viewerOffer(request);
  } catch (const RpcFailure &failure) {
    fail("viewerOffer refused a valid offer: " + failure.code + " " + failure.message);
  }
  if (!waitFor([&] { return consumerCount(state) == 1; }, 2000)) {
    fail("the worker did not register as a preview consumer for its viewer");
  }

  // The worker pulls frames for its viewer.
  const std::vector<uint8_t> rgba(static_cast<size_t>(kWidth) * kHeight * 4, 128);
  publishFrames(frames, rgba, 10);
  if (!waitFor([&] { return handledFrames(stream) >= 3; }, 10000)) {
    fail("the worker did not take frames for its viewer: " + stream.statusJson());
  }

  // Nothing new in the store: the worker waits for the next frame. The control for the measurement below.
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const double waitingShare = cpuShareOver(500);

  // The store is cleared while the viewer stays.
  frames.clear();
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  const double clearedShare = cpuShareOver(1000);
  std::cout << "program_stream_idle_test: CPU share of wall time, waiting for a frame " << waitingShare << ", store cleared "
            << clearedShare << std::endl;
  if (clearedShare > kMaxIdleCpuShare) {
    fail("the worker spins on a cleared store: CPU share " + std::to_string(clearedShare) + " of wall time, waiting for a frame it is " +
         std::to_string(waitingShare));
  }

  // The pause must not cost the next frame: it is taken as soon as the pipeline publishes again.
  const uint64_t handledBefore = handledFrames(stream);
  publishFrames(frames, rgba, 3);
  if (!waitFor([&] { return handledFrames(stream) > handledBefore; }, 5000)) {
    fail("the worker did not take the frame published after the cleared store: " + stream.statusJson());
  }

  stream.stop();
  browser->close();
  std::cout << "program_stream_idle_test passed" << std::endl;
  return 0;
}
