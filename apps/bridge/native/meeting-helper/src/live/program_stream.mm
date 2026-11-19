#include "live/program_stream.h"

#include "live_stream/bitrate_ladder.h"
#include "live_stream/monotonic_clock.h"
#include "live_stream/publisher.h"
#include "live_stream/video_encoder.h"
#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"
#include "util/pixel_swizzle.h"
#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace broadify::meeting {

using broadify::helper::jsonEscape;

namespace {

constexpr auto kIdlePoll = std::chrono::milliseconds(100);
constexpr auto kFrameWait = std::chrono::milliseconds(200);
constexpr auto kHousekeeping = std::chrono::seconds(1);
constexpr int kPoolMinBuffers = 3;

}  // namespace

struct ProgramStream::Impl {
  Impl(PreviewFrameStore &framesIn, MeetingState &stateIn, ProgramStreamConfig configIn)
      : frames(framesIn), state(stateIn), config(configIn) {}

  PreviewFrameStore &frames;
  MeetingState &state;
  ProgramStreamConfig config;

  std::unique_ptr<live::WebRtcPublisher> publisher;
  std::unique_ptr<live::VideoEncoder> encoder;
  live::EncodeTarget target;
  bool encoderConfigured = false;
  std::string profile = "auto";
  std::string lastErrorCode;
  std::string lastErrorMessage;
  CVPixelBufferPoolRef pool = nullptr;

  std::thread worker;
  std::atomic<bool> running{false};
  std::atomic<bool> keyframeWanted{false};
  std::mutex mutex;              // encoder/pool/profile/error
  std::mutex wakeMutex;
  std::condition_variable wake;  // stop() wakes an idle worker
  bool consumerRegistered = false;

  std::atomic<uint64_t> encodedFrames{0};
  std::atomic<uint64_t> droppedFrames{0};
  std::atomic<uint64_t> encodedBytes{0};

  void setConsumer(bool active) {
    if (active == consumerRegistered) {
      return;
    }
    consumerRegistered = active;
    std::lock_guard<std::mutex> lock(state.mutex);
    state.programStreamClientCount = active ? 1 : 0;
    // A joining viewer needs a fresh frame even when the program is static.
    state.programDirty = true;
    ++state.programRevision;
  }

  void teardownEncoderLocked() {
    encoder.reset();
    encoderConfigured = false;
    if (pool != nullptr) {
      CVPixelBufferPoolRelease(pool);
      pool = nullptr;
    }
  }

  bool ensureEncoderLocked(uint32_t width, uint32_t height) {
    const live::EncodeTarget wanted =
        live::selectEncodeTarget(width, height, config.fps == 0 ? 30u : config.fps, 1, live::parseEncodeProfile(profile));
    if (encoderConfigured && encoder && wanted.width == target.width && wanted.height == target.height &&
        wanted.bitrateKbps == target.bitrateKbps) {
      return true;
    }
    teardownEncoderLocked();
    encoder = live::createVideoToolboxEncoder();
    if (!encoder) {
      lastErrorCode = "encoder_unavailable";
      lastErrorMessage = "No hardware H.264 encoder on this machine.";
      return false;
    }
    encoder->onAccessUnit = [this](live::EncodedAccessUnit &&unit) { onAccessUnit(std::move(unit)); };
    std::string code;
    std::string error;
    if (!encoder->configure(wanted, code, error)) {
      lastErrorCode = code;
      lastErrorMessage = error;
      encoder.reset();
      return false;
    }
    NSDictionary *attrs = @{
      (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (__bridge NSString *)kCVPixelBufferWidthKey : @(wanted.width),
      (__bridge NSString *)kCVPixelBufferHeightKey : @(wanted.height),
      (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey : @{},
    };
    NSDictionary *poolAttrs = @{(__bridge NSString *)kCVPixelBufferPoolMinimumBufferCountKey : @(kPoolMinBuffers)};
    if (CVPixelBufferPoolCreate(kCFAllocatorDefault, (__bridge CFDictionaryRef)poolAttrs, (__bridge CFDictionaryRef)attrs, &pool) !=
        kCVReturnSuccess) {
      lastErrorCode = "encoder_unavailable";
      lastErrorMessage = "CVPixelBufferPool for the program stream could not be created.";
      teardownEncoderLocked();
      return false;
    }
    target = wanted;
    encoderConfigured = true;
    lastErrorCode.clear();
    lastErrorMessage.clear();
    keyframeWanted.store(true);
    broadify::helper::emitHelperEvent("{\"type\":\"meeting_program_stream\",\"event\":\"encoder_configured\",\"width\":" +
                                      std::to_string(wanted.width) + ",\"height\":" + std::to_string(wanted.height) +
                                      ",\"fps\":" + std::to_string(wanted.fpsNum) + ",\"bitrate_kbps\":" +
                                      std::to_string(wanted.bitrateKbps) + ",\"profile\":\"" + jsonEscape(wanted.profileName) + "\"}");
    return true;
  }

  void onAccessUnit(live::EncodedAccessUnit &&unit) {
    encodedFrames.fetch_add(1);
    encodedBytes.fetch_add(unit.annexB.size());
    if (publisher) {
      publisher->sendVideo(unit);
    }
    if (unit.sample != nullptr) {
      CFRelease(unit.sample);  // no passthrough recorder here; the meeting recorder has its own writer
      unit.sample = nullptr;
    }
  }

  // Runs under the PreviewFrameStore lock: one RGBA→BGRA pass straight into the pooled buffer.
  void encodeFrame(const PreviewFrame &frame) {
    live::VideoEncoder *activeEncoder = nullptr;
    CVPixelBufferRef pixelBuffer = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!ensureEncoderLocked(frame.width, frame.height)) {
        droppedFrames.fetch_add(1);
        return;
      }
      if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer) != kCVReturnSuccess || pixelBuffer == nullptr) {
        droppedFrames.fetch_add(1);  // every pooled buffer still sits in the encoder: drop, never block
        return;
      }
      activeEncoder = encoder.get();
    }
    CVPixelBufferLockBaseAddress(pixelBuffer, 0);
    uint8_t *dst = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
    const size_t dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
    const size_t srcStride = static_cast<size_t>(frame.width) * 4;
    const size_t rows = static_cast<size_t>(frame.height);
    if (frame.rgba.size() >= srcStride * rows) {
      for (size_t row = 0; row < rows; ++row) {
        swizzleRgbaToBgra(frame.rgba.data() + row * srcStride, dst + row * dstStride, frame.width);
      }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
    live::CapturedFrame captured;
    captured.pixelBuffer = pixelBuffer;
    captured.width = frame.width;
    captured.height = frame.height;
    captured.pixelFormat = "bgra";
    captured.captureNs = live::monotonicNowNs();
    if (!activeEncoder->encode(captured, keyframeWanted.exchange(false))) {
      droppedFrames.fetch_add(1);
    }
    CVPixelBufferRelease(pixelBuffer);  // VideoToolbox retains it for the encode
  }

  void run() {
    uint64_t lastSequence = 0;
    auto lastHousekeeping = std::chrono::steady_clock::now();
    while (running.load()) {
      const size_t viewers = publisher ? publisher->viewerCount() : 0;
      setConsumer(viewers > 0);
      const auto now = std::chrono::steady_clock::now();
      if (now - lastHousekeeping >= kHousekeeping) {
        lastHousekeeping = now;
        if (publisher && publisher->reapDead() > 0) {
          broadify::helper::emitHelperEvent("{\"type\":\"meeting_program_stream\",\"event\":\"viewers_reaped\",\"viewers\":" +
                                            std::to_string(publisher->viewerCount()) + "}");
        }
      }
      if (viewers == 0) {
        std::unique_lock<std::mutex> lock(wakeMutex);
        wake.wait_for(lock, kIdlePoll, [this]() { return !running.load(); });
        lastSequence = 0;  // the next viewer starts from the freshest frame
        continue;
      }
      if (!frames.waitForNewFrame(lastSequence, now + kFrameWait)) {
        continue;
      }
      frames.visitLatestIfNew(lastSequence, [&](const PreviewFrame &frame) {
        lastSequence = frame.sequence;
        encodeFrame(frame);
      });
    }
    setConsumer(false);
  }
};

ProgramStream::ProgramStream(PreviewFrameStore &frames, MeetingState &state, ProgramStreamConfig config)
    : impl_(new Impl(frames, state, config)) {}

ProgramStream::~ProgramStream() {
  stop();
  delete impl_;
}

void ProgramStream::start() {
  if (impl_->running.exchange(true)) {
    return;
  }
  impl_->publisher =
      std::make_unique<live::WebRtcPublisher>([this]() { impl_->keyframeWanted.store(true); }, "meeting_viewer_state");
  impl_->worker = std::thread([this]() { impl_->run(); });
}

void ProgramStream::stop() {
  if (!impl_->running.exchange(false)) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(impl_->wakeMutex);
    impl_->wake.notify_all();
  }
  if (impl_->worker.joinable()) {
    impl_->worker.join();
  }
  if (impl_->publisher) {
    impl_->publisher->closeAll();
  }
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->encoder) {
    impl_->encoder->flush();
  }
  impl_->teardownEncoderLocked();
  impl_->publisher.reset();
}

bool ProgramStream::supported() const { return true; }

std::string ProgramStream::viewerOffer(const live::ViewerOfferRequest &request) {
  if (!impl_->running.load() || !impl_->publisher) {
    throw live::RpcFailure{"program_stream_unavailable", "The program stream is not running."};
  }
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->publisher->viewerCount() == 0 && !request.profile.empty()) {
      impl_->profile = request.profile;  // the first viewer picks the ladder profile
    }
  }
  const std::string answer = impl_->publisher->addViewer(request, /*audioAvailable=*/false);
  impl_->keyframeWanted.store(true);
  return answer;
}

void ProgramStream::viewerClose(const std::string &viewerId) {
  if (impl_->publisher) {
    impl_->publisher->removeViewer(viewerId);
  }
}

size_t ProgramStream::viewerCount() const { return impl_->publisher ? impl_->publisher->viewerCount() : 0; }

std::string ProgramStream::sessionsJson() const { return impl_->publisher ? impl_->publisher->sessionsJson() : "[]"; }

std::string ProgramStream::statusJson() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const size_t viewers = viewerCount();
  std::string encoderJson = "null";
  if (impl_->encoderConfigured && impl_->encoder) {
    const live::EncoderInfo info = impl_->encoder->info();
    encoderJson = "{\"backend\":\"" + jsonEscape(info.backend) + "\",\"hardware\":" + (info.hardware ? "true" : "false") +
                  ",\"width\":" + std::to_string(impl_->target.width) + ",\"height\":" + std::to_string(impl_->target.height) +
                  ",\"fps\":" + std::to_string(impl_->target.fpsNum) + ",\"bitrate_kbps\":" + std::to_string(impl_->target.bitrateKbps) +
                  ",\"profile\":\"" + jsonEscape(impl_->target.profileName) + "\"}";
  }
  std::string errorJson = "null";
  if (!impl_->lastErrorCode.empty()) {
    errorJson = "{\"code\":\"" + jsonEscape(impl_->lastErrorCode) + "\",\"message\":\"" + jsonEscape(impl_->lastErrorMessage) + "\"}";
  }
  return "{\"supported\":true,\"active\":" + std::string(viewers > 0 ? "true" : "false") + ",\"viewers\":" + std::to_string(viewers) +
         ",\"encoder\":" + encoderJson + ",\"encoded_frames\":" + std::to_string(impl_->encodedFrames.load()) +
         ",\"dropped_frames\":" + std::to_string(impl_->droppedFrames.load()) + ",\"encoded_bytes\":" +
         std::to_string(impl_->encodedBytes.load()) + ",\"last_error\":" + errorJson + "}";
}

}  // namespace broadify::meeting
