// The real ProgramStream worker end to end: a libdatachannel "browser" in this
// process offers a recvonly video section, program frames are published into
// PreviewFrameStore the way the frame pipeline does, and the receiver sees RTP.
// Covers what the RPC test with the stub cannot: consumer registration, the
// frame hand-over, encoder set-up from the frame geometry, reconfiguration on
// a program format change (1920x1080 -> 1080x1920) and on a profile change,
// idle without viewers, stop and restart.
//
// Built twice from this file:
//   program_stream_loopback_test       the platform's frame converter and its
//       hardware encoder (macOS: VideoToolbox, Windows: Media Foundation). On
//       a machine without a hardware H.264 encoder the stream must report
//       `encoder_unavailable` and encode nothing: there is no software path.
//   program_stream_nv12_loopback_test  the NV12 converter (the Windows one,
//       pure C++) on top of an encoder defined in this test
//       (PROGRAM_STREAM_TEST_ENCODER). Runs on every platform without
//       hardware: the frames must arrive as frame-size NV12 with the right
//       pixels, no encoder call may happen while the PreviewFrameStore lock is
//       held, and a failed encoder set-up must not be repeated with every frame.
#include "live/program_stream.h"

#include "helper_common/helper_event_log.h"
#include "live_stream/bitrate_ladder.h"
#include "live_stream/video_encoder.h"
#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <rtc/rtc.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::live;
using broadify::meeting::MeetingState;
using broadify::meeting::PreviewFrameStore;
using broadify::meeting::ProgramStream;
using broadify::meeting::ProgramStreamConfig;

#if defined(PROGRAM_STREAM_TEST_ENCODER)
#define TEST_NAME "program_stream_nv12_loopback_test"
#else
#define TEST_NAME "program_stream_loopback_test"
#endif

namespace {

[[noreturn]] void fail(const std::string &message) {
  std::cerr << TEST_NAME " failed: " << message << std::endl;
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

bool contains(const std::string &haystack, const std::string &needle) { return haystack.find(needle) != std::string::npos; }

/** Unsigned number behind `"key":` in a flat JSON object; fails the test when the key is missing. */
uint64_t numberField(const std::string &json, const std::string &key) {
  const std::string marker = "\"" + key + "\":";
  const size_t at = json.find(marker);
  if (at == std::string::npos) {
    fail("no \"" + key + "\" in " + json);
  }
  return std::strtoull(json.c_str() + at + marker.size(), nullptr, 10);
}

// Left half red, right half blue: two flat areas whose NV12 values are known.
std::vector<uint8_t> makeProgramFrame(uint32_t width, uint32_t height) {
  std::vector<uint8_t> rgba(static_cast<size_t>(width) * height * 4);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      uint8_t *px = rgba.data() + (static_cast<size_t>(y) * width + x) * 4;
      const bool left = x < width / 2;
      px[0] = left ? 255 : 0;
      px[1] = 0;
      px[2] = left ? 0 : 255;
      px[3] = 255;
    }
  }
  return rgba;
}

/** Publishes one program frame every 33 ms, like the frame pipeline while a preview consumer is registered. */
class FramePublisher {
 public:
  explicit FramePublisher(PreviewFrameStore &store) : store_(store) {}
  ~FramePublisher() { stop(); }

  void start(uint32_t width, uint32_t height) {
    stop();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      width_ = width;
      height_ = height;
      rgba_ = makeProgramFrame(width, height);
    }
    running_.store(true);
    thread_ = std::thread([this] {
      while (running_.load()) {
        {
          std::lock_guard<std::mutex> lock(mutex_);
          store_.publish(width_, height_, rgba_.data(), rgba_.size());
        }
        published_.fetch_add(1);
        std::this_thread::sleep_for(std::chrono::milliseconds(33));
      }
    });
  }

  void stop() {
    running_.store(false);
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  uint64_t published() const { return published_.load(); }

 private:
  PreviewFrameStore &store_;
  std::mutex mutex_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  std::vector<uint8_t> rgba_;
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> published_{0};
  std::thread thread_;
};

/**
 * Rewrites the ICE candidates of an SDP to one host candidate on the loopback
 * address with the same port. Both PeerConnections bind their socket to every
 * local address, so the checks then run over the loopback interface. On the
 * host's own LAN addresses, datagrams between two sockets of one process are
 * dropped by local packet filters on some machines (application firewall,
 * VPN clients), which has nothing to do with the stream under test.
 */
std::string signalLoopbackCandidate(const std::string &sdp) {
  std::string out;
  bool written = false;
  size_t pos = 0;
  while (pos < sdp.size()) {
    size_t end = sdp.find('\n', pos);
    end = end == std::string::npos ? sdp.size() : end + 1;
    const std::string line = sdp.substr(pos, end - pos);
    pos = end;
    if (line.rfind("a=candidate:", 0) != 0) {
      out += line;
      continue;
    }
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ host
    size_t address = 0;
    for (int field = 0; field < 4 && address != std::string::npos; ++field) {
      address = line.find(' ', address);
      address = address == std::string::npos ? address : address + 1;
    }
    const size_t addressEnd = address == std::string::npos ? address : line.find(' ', address);
    const bool ipv4 = addressEnd != std::string::npos && line.find('.', address) < addressEnd;
    if (written || !ipv4 || !contains(line, " typ host")) {
      continue;
    }
    out += line.substr(0, address) + "127.0.0.1" + line.substr(addressEnd);
    written = true;
  }
  // No IPv4 host candidate to rewrite: leave the description as it was.
  return written ? out : sdp;
}

/** The receiving side: a PeerConnection with one recvonly H.264 section, as the web app's viewer offers it. */
struct Browser {
  std::string viewerId;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<std::atomic<int>> rtpPackets = std::make_shared<std::atomic<int>>(0);

  std::string offer() {
    rtc::Configuration config;
    pc = std::make_shared<rtc::PeerConnection>(config);
    rtc::Description::Video video("0", rtc::Description::Direction::RecvOnly);
    video.addH264Codec(96, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f");
    track = pc->addTrack(video);
    auto gathered = std::make_shared<std::promise<void>>();
    auto once = std::make_shared<std::atomic<bool>>(false);
    pc->onGatheringStateChange([gathered, once](rtc::PeerConnection::GatheringState state) {
      if (state == rtc::PeerConnection::GatheringState::Complete && !once->exchange(true)) {
        gathered->set_value();
      }
    });
    auto packets = rtpPackets;
    track->onMessage([packets](rtc::message_variant) { packets->fetch_add(1); });
    pc->setLocalDescription();
    if (gathered->get_future().wait_for(std::chrono::seconds(10)) != std::future_status::ready) {
      fail("browser ICE gathering timeout");
    }
    const auto description = pc->localDescription();
    if (!description) {
      fail("browser has no offer");
    }
    return std::string(*description);
  }

  bool connect(const std::string &answer) {
    pc->setRemoteDescription(rtc::Description(answer, rtc::Description::Type::Answer));
    return waitFor([this] { return pc->state() == rtc::PeerConnection::State::Connected && track->isOpen(); }, 10000);
  }

  void close() {
    if (pc) {
      pc->close();
    }
  }
};

/**
 * One viewer session against the stream. ICE runs over the loopback interface;
 * if that does not connect, one attempt uses the candidates as gathered and a
 * last one the loopback again.
 */
std::unique_ptr<Browser> joinViewer(ProgramStream &stream, const std::string &name, const std::string &profile) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    const bool loopback = attempt != 1;
    auto browser = std::make_unique<Browser>();
    browser->viewerId = name + "-" + std::to_string(attempt + 1);
    const std::string &viewerId = browser->viewerId;
    ViewerOfferRequest request;
    request.viewerId = viewerId;
    request.sdp = loopback ? signalLoopbackCandidate(browser->offer()) : browser->offer();
    request.profile = profile;
    std::string answer;
    try {
      answer = stream.viewerOffer(request);
    } catch (const RpcFailure &failure) {
      fail("viewerOffer refused a valid offer: " + failure.code + " " + failure.message);
    }
    if (!contains(answer, "a=sendonly") || !contains(answer, "H264/90000")) {
      fail("answer is not a sendonly H.264 section");
    }
    if (contains(answer, "opus")) {
      fail("the program stream has no audio: the answer must not offer Opus");
    }
    if (browser->connect(loopback ? signalLoopbackCandidate(answer) : answer)) {
      return browser;
    }
    std::cerr << TEST_NAME ": viewer " << viewerId << " did not connect (attempt " << attempt + 1 << ")" << std::endl;
    stream.viewerClose(viewerId);
    browser->close();
  }
  fail("the viewer did not connect");
}

int consumerCount(MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.programStreamClientCount;
}

std::vector<std::string> encoderConfiguredEvents(const std::string &path) {
  std::vector<std::string> events;
  std::ifstream file(path);
  std::string line;
  while (std::getline(file, line)) {
    if (contains(line, "\"type\":\"meeting_program_stream\"") && contains(line, "\"event\":\"encoder_configured\"")) {
      events.push_back(line);
    }
  }
  return events;
}

std::string encoderJsonFor(const EncodeTarget &target) {
  return "\"width\":" + std::to_string(target.width) + ",\"height\":" + std::to_string(target.height) + ",\"fps\":" +
         std::to_string(target.fpsNum) + ",\"bitrate_kbps\":" + std::to_string(target.bitrateKbps) + ",\"profile\":\"" +
         target.profileName + "\"";
}

#if defined(PROGRAM_STREAM_TEST_ENCODER)

// --- the encoder of the NV12 build ---------------------------------------------

// BT.709 limited range of the two halves of makeProgramFrame().
constexpr uint8_t kRedY = 63, kRedCb = 102, kRedCr = 240;
constexpr uint8_t kBlueY = 32, kBlueCb = 240, kBlueCr = 118;

struct TestEncoderState {
  std::mutex mutex;
  PreviewFrameStore *store = nullptr;
  bool failConfigure = false;
  int configureAttempts = 0;
  int failedAttempts = 0;
  std::vector<std::chrono::steady_clock::time_point> attemptTimes;
  std::vector<EncodeTarget> configured;
  uint64_t frames = 0;
  uint64_t forcedKeyframes = 0;
  uint32_t lastWidth = 0;
  uint32_t lastHeight = 0;
  uint64_t lastCaptureNs = 0;
  int storeLockProbes = 0;
  std::string violation;  // first broken expectation seen on the worker thread
};

TestEncoderState &encoderState() {
  static TestEncoderState state;
  return state;
}

void noteViolation(const std::string &what) {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.violation.empty()) {
    state.violation = what;
  }
}

// The store's lock is free when another thread gets through one of its accessors in time.
void probeStoreLock(const char *during) {
  PreviewFrameStore *store = nullptr;
  {
    TestEncoderState &state = encoderState();
    std::lock_guard<std::mutex> lock(state.mutex);
    store = state.store;
    ++state.storeLockProbes;
  }
  if (store == nullptr) {
    return;
  }
  auto done = std::make_shared<std::promise<void>>();
  std::future<void> finished = done->get_future();
  std::thread([store, done] {
    (void)store->sequence();
    done->set_value();
  }).detach();
  if (finished.wait_for(std::chrono::seconds(2)) != std::future_status::ready) {
    noteViolation(std::string("the PreviewFrameStore lock is held during ") + during);
  }
}

uint8_t planeByte(const FramePlane &plane, uint32_t x, uint32_t y) { return plane.data[static_cast<size_t>(y) * plane.stride + x]; }

void checkNv12Frame(const CapturedFrame &frame) {
  if (frame.pixelFormat != "nv12" || frame.planeCount != 2 || frame.nativeHandle != nullptr) {
    noteViolation("the frame is not NV12 in two CPU planes");
    return;
  }
  const uint32_t chromaWidth = (frame.width + 1) / 2;
  const uint32_t chromaRows = (frame.height + 1) / 2;
  if (frame.width == 0 || frame.height == 0 || frame.planes[0].data == nullptr || frame.planes[1].data == nullptr ||
      frame.planes[0].stride < frame.width || frame.planes[0].rows != frame.height || frame.planes[1].stride < 2 * chromaWidth ||
      frame.planes[1].rows != chromaRows) {
    noteViolation("NV12 plane geometry does not match the frame size");
    return;
  }
  const uint32_t leftX = frame.width / 4;
  const uint32_t rightX = frame.width - 1 - frame.width / 4;
  const uint32_t midY = frame.height / 2;
  const FramePlane &luma = frame.planes[0];
  const FramePlane &chroma = frame.planes[1];
  const bool red = planeByte(luma, leftX, midY) == kRedY && planeByte(luma, 0, 0) == kRedY &&
                   planeByte(chroma, 2 * (leftX / 2), midY / 2) == kRedCb && planeByte(chroma, 2 * (leftX / 2) + 1, midY / 2) == kRedCr;
  const bool blue = planeByte(luma, rightX, midY) == kBlueY && planeByte(luma, frame.width - 1, frame.height - 1) == kBlueY &&
                    planeByte(chroma, 2 * (rightX / 2), midY / 2) == kBlueCb &&
                    planeByte(chroma, 2 * (rightX / 2) + 1, chromaRows - 1) == kBlueCr;
  if (!red || !blue) {
    noteViolation("NV12 pixels are not the BT.709 limited-range values of the program frame");
  }
}

class TestEncoder final : public VideoEncoder {
 public:
  bool configure(const EncodeTarget &target, std::string &errorCode, std::string &error) override {
    probeStoreLock("VideoEncoder::configure");
    TestEncoderState &state = encoderState();
    std::lock_guard<std::mutex> lock(state.mutex);
    ++state.configureAttempts;
    state.attemptTimes.push_back(std::chrono::steady_clock::now());
    if (state.failConfigure) {
      ++state.failedAttempts;
      errorCode = "encoder_unavailable";
      error = "test encoder: no hardware encoder";
      return false;
    }
    state.configured.push_back(target);
    configured_ = true;
    first_ = true;
    return true;
  }

  bool encode(const CapturedFrame &frame, bool forceKeyframe) override {
    if (!configured_) {
      noteViolation("encode() on an encoder that was never configured");
      return false;
    }
    uint64_t index = 0;
    {
      TestEncoderState &state = encoderState();
      std::lock_guard<std::mutex> lock(state.mutex);
      index = state.frames++;
      if (forceKeyframe) {
        ++state.forcedKeyframes;
      }
      if (frame.captureNs < state.lastCaptureNs) {
        state.violation = state.violation.empty() ? "capture timestamps went backwards" : state.violation;
      }
      state.lastCaptureNs = frame.captureNs;
      state.lastWidth = frame.width;
      state.lastHeight = frame.height;
    }
    if (index < 5 || index % 15 == 0) {
      probeStoreLock("VideoEncoder::encode");
    }
    checkNv12Frame(frame);
    const bool keyframe = forceKeyframe || first_;
    first_ = false;
    EncodedAccessUnit unit;
    unit.keyframe = keyframe;
    unit.captureNs = frame.captureNs;
    if (keyframe) {
      unit.annexB = {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22};
    } else {
      unit.annexB = {0, 0, 0, 1, 0x41, 0x9a, 0x24, 0x6c, 0x41, 0x7f};
    }
    unit.annexB.resize(unit.annexB.size() + 600, 0x33);
    if (onAccessUnit) {
      onAccessUnit(std::move(unit));
    }
    return true;
  }

  void setBitrate(uint32_t, uint32_t) override {}
  void requestKeyframe() override {}
  void flush() override {}
  EncoderInfo info() const override {
    EncoderInfo info;
    info.backend = "test";
    info.hardware = true;
    return info;
  }

 private:
  bool configured_ = false;
  bool first_ = true;
};

int configureAttempts() {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.configureAttempts;
}

int failedAttempts() {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.failedAttempts;
}

/** Milliseconds between two set-up attempts (0-based, in the order they ran). */
long long msBetweenAttempts(size_t first, size_t second) {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  return std::chrono::duration_cast<std::chrono::milliseconds>(state.attemptTimes.at(second) - state.attemptTimes.at(first)).count();
}

size_t configuredEncoders() {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.configured.size();
}

uint64_t encoderFrames() {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.frames;
}

void expectNoViolation(const char *where) {
  TestEncoderState &state = encoderState();
  std::lock_guard<std::mutex> lock(state.mutex);
  if (!state.violation.empty()) {
    fail(std::string(where) + ": " + state.violation);
  }
}

#endif  // PROGRAM_STREAM_TEST_ENCODER

}  // namespace

#if defined(PROGRAM_STREAM_TEST_ENCODER)
// Takes the place of the platform encoder: with this definition the encoder object of the live_stream
// archive is never pulled into this binary.
namespace broadify::live {
std::unique_ptr<VideoEncoder> createHardwareEncoder() { return std::make_unique<TestEncoder>(); }
}  // namespace broadify::live
#endif

int main() {
  rtc::InitLogger(rtc::LogLevel::Warning);
  const std::string eventLog =
      (std::filesystem::temp_directory_path() / (std::string(TEST_NAME) + "-events.jsonl")).u8string();
  broadify::helper::setHelperEventLogPath(eventLog);

  MeetingState state;
  PreviewFrameStore frames;
  FramePublisher publisher(frames);
  ProgramStream stream(frames, state, ProgramStreamConfig{1920, 1080, 30});
  if (!stream.supported()) {
    fail("this build links the real program stream: supported() must be true");
  }
#if defined(PROGRAM_STREAM_TEST_ENCODER)
  {
    std::lock_guard<std::mutex> lock(encoderState().mutex);
    encoderState().store = &frames;
  }
#endif

  // Before start(): offers are refused with the stable code.
  try {
    ViewerOfferRequest request;
    request.viewerId = "early";
    request.sdp = "v=0";
    stream.viewerOffer(request);
    fail("an offer before start() must be refused");
  } catch (const RpcFailure &failure) {
    if (failure.code != "program_stream_unavailable") {
      fail("offer before start(): code " + failure.code);
    }
  }

  stream.start();

  // Without viewers nothing is copied or encoded, whatever the pipeline publishes.
  publisher.start(1920, 1080);
  if (!waitFor([&] { return publisher.published() >= 10; }, 5000)) {
    fail("the frame publisher does not run");
  }
  std::string status = stream.statusJson();
  if (!contains(status, "\"supported\":true,\"active\":false,\"viewers\":0,\"encoder\":null,\"encoded_frames\":0,\"dropped_frames\":0,") ||
      !contains(status, "\"last_error\":null")) {
    fail("idle status: " + status);
  }
  if (consumerCount(state) != 0) {
    fail("a consumer is registered without a viewer");
  }
  if (stream.sessionsJson() != "[]") {
    fail("idle sessions: " + stream.sessionsJson());
  }

#if defined(PROGRAM_STREAM_TEST_ENCODER)
  // --- NV12 build: failed encoder set-up, then the frame hand-over ---------------
  {
    std::lock_guard<std::mutex> lock(encoderState().mutex);
    encoderState().failConfigure = true;
  }
#endif

  uint64_t revisionBefore = 0;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.programDirty = false;
    revisionBefore = state.programRevision;
  }
  const auto joinedAt = std::chrono::steady_clock::now();
  std::unique_ptr<Browser> viewer = joinViewer(stream, "viewer", "remote");
  if (!waitFor([&] { return consumerCount(state) == 1; }, 2000)) {
    fail("the worker did not register as a preview consumer for its viewer");
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.programDirty || state.programRevision <= revisionBefore) {
      fail("a joining viewer must mark the program dirty");
    }
  }
  if (stream.viewerCount() != 1 || !contains(stream.sessionsJson(), "\"viewer_id\":\"" + viewer->viewerId + "\"")) {
    fail("viewer bookkeeping: " + stream.sessionsJson());
  }

  bool hardware = true;
#if defined(PROGRAM_STREAM_TEST_ENCODER)
  // The set-up fails: `encoder_unavailable` with the encoder's message, frames are dropped, and the
  // attempt is not repeated with every frame (30 per second here) while the retry pause runs.
  if (!waitFor([&] { return numberField(stream.statusJson(), "dropped_frames") >= 25; }, 5000)) {
    fail("frames are not dropped while the encoder is unavailable: " + stream.statusJson());
  }
  status = stream.statusJson();
  if (!contains(status, "\"encoder\":null") ||
      !contains(status, "\"last_error\":{\"code\":\"encoder_unavailable\",\"message\":\"test encoder: no hardware encoder\"}") ||
      numberField(status, "encoded_frames") != 0) {
    fail("unavailable status: " + status);
  }
  {
    // One attempt, then one more per elapsed retry pause (3 s): never one per frame.
    const auto elapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - joinedAt).count();
    const int attempts = configureAttempts();
    if (attempts < 1 || attempts > 1 + static_cast<int>(elapsedMs / 3000)) {
      fail("the failed encoder set-up ran " + std::to_string(attempts) + " times in " + std::to_string(elapsedMs) + " ms");
    }
  }
  if (viewer->rtpPackets->load() != 0 || encoderFrames() != 0) {
    fail("something was encoded without an encoder");
  }
  expectNoViolation("unavailable");
  // The encoder becomes available: the next attempt after the pause configures it and the stream starts.
  {
    std::lock_guard<std::mutex> lock(encoderState().mutex);
    encoderState().failConfigure = false;
  }
  if (!waitFor([&] { return configuredEncoders() >= 1; }, 12000)) {
    fail("the encoder set-up was not retried after the pause");
  }
  // The same target is not tried again before the pause is over.
  if (msBetweenAttempts(0, 1) < 2800) {
    fail("the failed target was tried again after " + std::to_string(msBetweenAttempts(0, 1)) + " ms");
  }
#endif

  // First viewer with profile "remote": a 1920x1080 program is encoded as 1280x720 (frame larger than the target).
  const EncodeTarget remoteLandscape = selectEncodeTarget(1920, 1080, 30, 1, EncodeProfile::Remote);
#if defined(PROGRAM_STREAM_TEST_ENCODER)
  if (!waitFor([&] { return numberField(stream.statusJson(), "encoded_frames") >= 15; }, 15000)) {
    fail("no frames encoded after the encoder became available: " + stream.statusJson());
  }
  status = stream.statusJson();
#else
  if (!waitFor(
          [&] {
            const std::string json = stream.statusJson();
            return contains(json, "\"code\":\"encoder_unavailable\"") || numberField(json, "encoded_frames") >= 15;
          },
          15000)) {
    fail("neither encoded frames nor encoder_unavailable: " + stream.statusJson());
  }
  status = stream.statusJson();
  if (contains(status, "\"code\":\"encoder_unavailable\"")) {
    // No hardware H.264 encoder on this machine (CI runner, VM): the doctrine case. Nothing may be encoded.
    hardware = false;
    if (!waitFor([&] { return numberField(stream.statusJson(), "dropped_frames") >= 25; }, 5000)) {
      fail("frames are not dropped while the encoder is unavailable: " + stream.statusJson());
    }
    status = stream.statusJson();
    if (!contains(status, "\"encoder\":null") || numberField(status, "encoded_frames") != 0 || numberField(status, "encoded_bytes") != 0) {
      fail("encoder_unavailable but something was encoded: " + status);
    }
    if (viewer->rtpPackets->load() != 0) {
      fail("encoder_unavailable but the viewer received RTP");
    }
    if (!encoderConfiguredEvents(eventLog).empty()) {
      fail("encoder_unavailable but an encoder_configured event was emitted");
    }
    std::cout << TEST_NAME ": no hardware encoder, status " << status << std::endl;
  }
#endif

  if (hardware) {
    if (!contains(status, "\"active\":true,\"viewers\":1,\"encoder\":{\"backend\":\"") || !contains(status, "\"hardware\":true") ||
        !contains(status, encoderJsonFor(remoteLandscape)) || !contains(status, "\"last_error\":null")) {
      fail("1920x1080 remote status: " + status);
    }
    if (numberField(status, "encoded_bytes") == 0) {
      fail("encoded frames without bytes: " + status);
    }
    if (!waitFor([&] { return viewer->rtpPackets->load() >= 15; }, 10000)) {
      fail("the viewer received too little RTP for the 1920x1080 program");
    }

    // The program turns portrait: the encoder follows the frame geometry (720x1280 for "remote").
    const EncodeTarget remotePortrait = selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Remote);
    publisher.start(1080, 1920);
    if (!waitFor([&] { return contains(stream.statusJson(), encoderJsonFor(remotePortrait)); }, 10000)) {
      fail("the encoder did not follow the program to 1080x1920: " + stream.statusJson());
    }
    const uint64_t encodedAtSwitch = numberField(stream.statusJson(), "encoded_frames");
    const int rtpAtSwitch = viewer->rtpPackets->load();
    if (!waitFor([&] { return numberField(stream.statusJson(), "encoded_frames") >= encodedAtSwitch + 15; }, 10000)) {
      fail("no frames encoded after the switch to 1080x1920: " + stream.statusJson());
    }
    if (!waitFor([&] { return viewer->rtpPackets->load() >= rtpAtSwitch + 15; }, 10000)) {
      fail("the viewer received too little RTP for the 1080x1920 program");
    }
  }

  // Every published frame is handed over at most once (one may be on its way while the counters are read).
  {
    const std::string json = stream.statusJson();
    const uint64_t handled = numberField(json, "encoded_frames") + numberField(json, "dropped_frames");
    if (handled > publisher.published() + 1) {
      fail("the worker handled " + std::to_string(handled) + " frames, " + std::to_string(publisher.published()) + " were published");
    }
  }

  // The viewer leaves: the consumer registration goes away and nothing is encoded any more.
  stream.viewerClose(viewer->viewerId);
  viewer->close();
  if (!waitFor([&] { return consumerCount(state) == 0; }, 2000)) {
    fail("the worker kept its consumer registration without a viewer");
  }
  if (stream.viewerCount() != 0 || !contains(stream.statusJson(), "\"active\":false,\"viewers\":0")) {
    fail("status after the viewer left: " + stream.statusJson());
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(300));  // frames still inside the encoder
  const std::string idleBefore = stream.statusJson();
  const uint64_t publishedIdle = publisher.published();
  if (!waitFor([&] { return publisher.published() >= publishedIdle + 10; }, 5000)) {
    fail("the frame publisher stopped");
  }
  const std::string idleAfter = stream.statusJson();
  if (numberField(idleBefore, "encoded_frames") != numberField(idleAfter, "encoded_frames") ||
      numberField(idleBefore, "dropped_frames") != numberField(idleAfter, "dropped_frames")) {
    fail("frames were handled without a viewer: " + idleBefore + " -> " + idleAfter);
  }

  if (hardware) {
    // A new first viewer picks the ladder profile: "lan" keeps the portrait program at 1080x1920.
    const EncodeTarget lanPortrait = selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Lan);
    std::unique_ptr<Browser> second = joinViewer(stream, "second-viewer", "lan");
    if (!waitFor([&] { return contains(stream.statusJson(), encoderJsonFor(lanPortrait)); }, 10000)) {
      fail("the first viewer's profile did not reconfigure the encoder: " + stream.statusJson());
    }
    if (!waitFor([&] { return second->rtpPackets->load() >= 15; }, 10000)) {
      fail("the second viewer received too little RTP");
    }
    // One encoder per target, in the order the program and the viewers asked for.
    const std::vector<std::string> events = encoderConfiguredEvents(eventLog);
    const EncodeTarget expected[] = {remoteLandscape, selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Remote), lanPortrait};
    if (events.size() != 3) {
      fail("expected 3 encoder_configured events, got " + std::to_string(events.size()));
    }
    for (size_t i = 0; i < 3; ++i) {
      if (!contains(events[i], encoderJsonFor(expected[i]))) {
        fail("encoder_configured event " + std::to_string(i) + ": " + events[i]);
      }
    }
#if defined(PROGRAM_STREAM_TEST_ENCODER)
    // A failed set-up holds back its own target only: when the program changes its size right after a
    // failure, the new target is tried at once instead of after the retry pause.
    {
      std::lock_guard<std::mutex> lock(encoderState().mutex);
      encoderState().failConfigure = true;
    }
    const int failedBefore = failedAttempts();
    const size_t attemptsBefore = static_cast<size_t>(configureAttempts());
    publisher.start(960, 540);
    if (!waitFor([&] { return failedAttempts() == failedBefore + 1; }, 5000)) {
      fail("no set-up attempt for the 960x540 program");
    }
    publisher.start(640, 360);
    if (!waitFor([&] { return failedAttempts() == failedBefore + 2; }, 2500)) {
      fail("a failed set-up held back the attempt for another target");
    }
    if (msBetweenAttempts(attemptsBefore, attemptsBefore + 1) >= 2500) {
      fail("the attempt for another target waited for the retry pause");
    }
    if (!contains(stream.statusJson(), "\"encoder\":null") || !contains(stream.statusJson(), "\"code\":\"encoder_unavailable\"")) {
      fail("status after the failed reconfiguration: " + stream.statusJson());
    }
#endif
    second->close();
  }

#if defined(PROGRAM_STREAM_TEST_ENCODER)
  {
    expectNoViolation("hand-over");
    TestEncoderState &encoder = encoderState();
    std::lock_guard<std::mutex> lock(encoder.mutex);
    const EncodeTarget expected[] = {remoteLandscape, selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Remote),
                                     selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Lan)};
    // The failed attempts of the beginning, then exactly one set-up per target.
    if (encoder.failedAttempts < 1 || encoder.configured.size() != 3 ||
        encoder.configureAttempts != encoder.failedAttempts + 3) {
      fail("encoder set-ups: " + std::to_string(encoder.configureAttempts) + " attempts, " + std::to_string(encoder.failedAttempts) +
           " failed, " + std::to_string(encoder.configured.size()) + " configured");
    }
    for (size_t i = 0; i < 3; ++i) {
      if (encoder.configured[i].width != expected[i].width || encoder.configured[i].height != expected[i].height ||
          encoder.configured[i].bitrateKbps != expected[i].bitrateKbps || encoder.configured[i].profileName != expected[i].profileName) {
        fail("encoder target " + std::to_string(i) + " does not come from the frame geometry and the viewer's profile");
      }
    }
    // The frames stay at the size of the program frame; scaling to the target is the encoder's input stage.
    if (encoder.lastWidth != 1080 || encoder.lastHeight != 1920) {
      fail("the last frame handed to the encoder is not the 1080x1920 program frame");
    }
    if (encoder.forcedKeyframes < 3) {
      fail("a new encoder or viewer must start on a forced keyframe");
    }
    if (encoder.storeLockProbes < 8) {
      fail("the store lock was not probed");
    }
  }
#endif

  // stop(): viewers are closed, later offers are refused; start() brings the stream back.
  stream.stop();
  if (stream.viewerCount() != 0 || consumerCount(state) != 0) {
    fail("stop() left a viewer or the consumer registration behind");
  }
  try {
    ViewerOfferRequest request;
    request.viewerId = "late";
    request.sdp = "v=0";
    stream.viewerOffer(request);
    fail("an offer after stop() must be refused");
  } catch (const RpcFailure &failure) {
    if (failure.code != "program_stream_unavailable") {
      fail("offer after stop(): code " + failure.code);
    }
  }
  stream.start();
  if (!contains(stream.statusJson(), "\"supported\":true,\"active\":false,\"viewers\":0,\"encoder\":null")) {
    fail("status after restart: " + stream.statusJson());
  }
  stream.stop();
  publisher.stop();
  broadify::helper::setHelperEventLogPath("");
  std::error_code ignored;
  std::filesystem::remove(std::filesystem::u8path(eventLog), ignored);

  std::cout << TEST_NAME " passed" << (hardware ? "" : " (no hardware encoder: encoder_unavailable, nothing encoded)") << std::endl;
  return 0;
}
