#include "pgm_engine.h"

#include "common/pgm_options.h"
#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#include <chrono>
#include <sstream>

namespace broadify::pgm {

using broadify::helper::emitHelperEvent;
using broadify::helper::jsonEscape;
using broadify::helper::nowNs;

namespace {

std::string inputJson(const VideoInputInfo &info) {
  std::ostringstream out;
  out << "{\"id\":\"" << jsonEscape(info.id) << "\",\"kind\":\"" << jsonEscape(info.kind) << "\",\"display_name\":\""
      << jsonEscape(info.displayName) << "\",\"device_id\":\"" << jsonEscape(info.deviceId) << "\",\"stable_key\":\""
      << jsonEscape(info.stableKey) << "\",\"available\":" << (info.available ? "true" : "false") << ",\"in_use\":"
      << (info.inUse ? "true" : "false") << "}";
  return out.str();
}

std::string signalJson(const VideoSignal &signal) {
  std::ostringstream out;
  out << "{\"width\":" << signal.width << ",\"height\":" << signal.height << ",\"fps_num\":" << signal.fpsNum
      << ",\"fps_den\":" << signal.fpsDen << ",\"scan\":\"progressive\",\"pixel_format\":\"" << jsonEscape(signal.pixelFormat)
      << "\",\"no_signal\":" << (signal.noSignal ? "true" : "false") << "}";
  return out.str();
}

}  // namespace

PgmEngine::PgmEngine(PgmEngineConfig config) : config_(std::move(config)) {
  publisher_ = std::make_unique<WebRtcPublisher>([this]() { keyframeWanted_.store(true); });
#if defined(__APPLE__)
  enumerator_ = createUvcEnumerator();
  enumerator_->setChangeHandler([this]() {
    emitHelperEvent("{\"type\":\"pgm_inputs_changed\"}");
    std::lock_guard<std::mutex> lock(mutex_);
    if (hasInput_ && input_.kind == "uvc") {
      bool present = false;
      for (const VideoInputInfo &info : enumerator_->list()) {
        if (info.stableKey == input_.stableKey) {
          present = true;
        }
      }
      if (!present && tracker_.markNoSignal()) {
        emitHelperEvent("{\"type\":\"pgm_signal\",\"signal\":" + signalJson(tracker_.signal()) + "}");
      }
    }
  });
#endif
}

PgmEngine::~PgmEngine() { stop(); }

void PgmEngine::start() {
  if (running_.exchange(true)) {
    return;
  }
  housekeeping_ = std::thread([this]() { housekeeping(); });
  if (!config_.syntheticSource.empty()) {
    selectSource("synthetic:" + config_.syntheticSource, "lan");
  }
}

void PgmEngine::stop() {
  if (!running_.exchange(false)) {
    return;
  }
  if (housekeeping_.joinable()) {
    housekeeping_.join();
  }
  clearSource();
  publisher_->closeAll();
}

std::string PgmEngine::inputsListJson() {
  std::string json = "{\"inputs\":[";
  bool first = true;
  if (enumerator_) {
    for (const VideoInputInfo &info : enumerator_->list()) {
      json += (first ? "" : ",") + inputJson(info);
      first = false;
    }
  }
  json += "],\"camera_permission\":\"";
  json += enumerator_ ? jsonEscape(enumerator_->ensureCameraAuthorization()) : "unavailable";
  return json + "\"}";
}

std::string PgmEngine::stateLocked() const {
  if (!lastErrorCode_.empty()) {
    return "error";
  }
  if (!hasInput_) {
    return "idle";
  }
  if (tracker_.signal().noSignal) {
    return encoderConfigured_ ? "no_signal" : "starting";
  }
  return "running";
}

std::string PgmEngine::statusJsonLocked() const {
  std::ostringstream out;
  out << "{\"enabled\":true,\"state\":\"" << stateLocked() << "\",\"input\":" << (hasInput_ ? inputJson(input_) : "null")
      << ",\"signal\":" << (hasInput_ ? signalJson(tracker_.signal()) : "null") << ",\"encoder\":";
  if (encoderConfigured_ && encoder_) {
    const EncoderInfo info = encoder_->info();
    out << "{\"backend\":\"" << jsonEscape(info.backend) << "\",\"hardware\":" << (info.hardware ? "true" : "false")
        << ",\"bitrate_kbps\":" << target_.bitrateKbps << ",\"profile\":\"" << jsonEscape(target_.profileName) << "\"}";
  } else {
    out << "null";
  }
  out << ",\"audio\":" << (audioRunning_ ? "true" : "false") << ",\"viewers\":" << publisher_->viewerCount() << ",\"last_error\":";
  if (lastErrorCode_.empty()) {
    out << "null";
  } else {
    out << "{\"code\":\"" << jsonEscape(lastErrorCode_) << "\",\"message\":\"" << jsonEscape(lastErrorMessage_) << "\"}";
  }
  out << "}";
  return out.str();
}

std::string PgmEngine::statusJson() {
  std::lock_guard<std::mutex> lock(mutex_);
  return statusJsonLocked();
}

std::string PgmEngine::perfJson() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::ostringstream out;
  out << "{\"capture_fps\":" << captureFps_ << ",\"encode_fps\":" << encodeFps_ << ",\"bitrate_kbps\":" << bitrateKbps_
      << ",\"dropped\":" << droppedFrames_.load() << ",\"viewers\":" << publisher_->viewerCount() << "}";
  return out.str();
}

std::string PgmEngine::sessionsJson() {
  return "{\"sessions\":" + publisher_->sessionsJson() + "}";
}

void PgmEngine::setErrorLocked(const std::string &code, const std::string &message) {
  lastErrorCode_ = code;
  lastErrorMessage_ = message;
  emitHelperEvent("{\"type\":\"pgm_error\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}");
}

void PgmEngine::emitStatus() {
  std::string json;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    json = statusJsonLocked();
  }
  emitHelperEvent("{\"type\":\"pgm_status\",\"status\":" + json + "}");
}

void PgmEngine::selectSource(const std::string &inputId, const std::string &profile) {
  std::unique_ptr<VideoSource> source;
  VideoInputInfo info;
  if (inputId.rfind("synthetic:", 0) == 0) {
    uint32_t width = 0;
    uint32_t height = 0;
    double fps = 0.0;
    if (!parseSyntheticSpec(inputId.substr(10), width, height, fps)) {
      throw RpcFailure{"input_not_found", "Synthetic source spec must be WxH@fps."};
    }
#if defined(__APPLE__)
    source = createSyntheticSource(width, height, fps);
#endif
    info.id = inputId;
    info.kind = "uvc";
    info.displayName = "Synthetic " + inputId.substr(10);
    info.stableKey = inputId;
  } else {
    if (!enumerator_) {
      throw RpcFailure{"input_not_found", "No video input backend on this platform."};
    }
    const std::string permission = enumerator_->ensureCameraAuthorization();
    if (permission != "authorized") {
      throw RpcFailure{"camera_permission_denied", "Camera access is " + permission + "."};
    }
    for (const VideoInputInfo &candidate : enumerator_->list()) {
      if (candidate.id == inputId || candidate.stableKey == inputId) {
        info = candidate;
      }
    }
    if (info.id.empty()) {
      throw RpcFailure{"input_not_found", "No video input with id " + inputId + "."};
    }
    source = enumerator_->open(info.stableKey);
    if (!source) {
      throw RpcFailure{"input_not_found", "The video input disappeared."};
    }
  }
  clearSource();
  std::string errorCode;
  std::string error;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    profile_ = parseEncodeProfile(profile);
    input_ = info;
    hasInput_ = true;
    lastErrorCode_.clear();
    lastErrorMessage_.clear();
    tracker_ = VideoSignalTracker();
    encoderConfigured_ = false;
    source_ = std::move(source);
    if (!source_->start([this](const CapturedFrame &frame) { onFrame(frame); }, errorCode, error)) {
      source_.reset();
      hasInput_ = false;
      setErrorLocked(errorCode, error);
    } else if (inputId.rfind("synthetic:", 0) != 0) {
      startAudioLocked(info.displayName);
    }
  }
  if (!errorCode.empty()) {
    throw RpcFailure{errorCode, error};
  }
  emitStatus();
}

void PgmEngine::clearSource() {
  std::unique_ptr<VideoSource> source;
  std::unique_ptr<VideoEncoder> encoder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    source = std::move(source_);
    encoder = std::move(encoder_);
    stopAudioLocked();
    hasInput_ = false;
    encoderConfigured_ = false;
    tracker_ = VideoSignalTracker();
  }
  if (source) {
    source->stop();
  }
  if (encoder) {
    encoder->flush();
  }
  emitStatus();
}

void PgmEngine::startAudioLocked(const std::string &displayName) {
#if defined(__APPLE__)
  audioSource_ = createPairedAudioSource(displayName);
  if (!audioSource_) {
    return;
  }
  opus_ = std::make_unique<OpusAudioEncoder>();
  if (!opus_->ready()) {
    audioSource_.reset();
    opus_.reset();
    return;
  }
  opus_->onPacket = [this](EncodedAudioPacket &&packet) { publisher_->sendAudio(packet); };
  std::string code;
  std::string error;
  if (!audioSource_->start([this](const AudioChunk &chunk) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (opus_) {
          opus_->push(chunk);
        }
      }, code, error)) {
    emitHelperEvent("{\"type\":\"pgm_audio_unavailable\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(error) + "\"}");
    audioSource_.reset();
    opus_.reset();
    return;
  }
  audioRunning_ = true;
#else
  (void)displayName;
#endif
}

void PgmEngine::stopAudioLocked() {
  if (audioSource_) {
    audioSource_->stop();
    audioSource_.reset();
  }
  opus_.reset();
  audioRunning_ = false;
}

bool PgmEngine::ensureEncoderForSignalLocked(std::string &errorCode, std::string &error) {
  const VideoSignal &signal = tracker_.signal();
  if (signal.noSignal || signal.width == 0 || signal.fpsNum == 0) {
    return false;
  }
  const EncodeTarget target = selectEncodeTarget(signal.width, signal.height, signal.fpsNum, signal.fpsDen, profile_);
  if (encoderConfigured_ && encoder_ && target.width == target_.width && target.height == target_.height &&
      target.fpsNum == target_.fpsNum && target.fpsDen == target_.fpsDen) {
    return true;
  }
  if (!encoder_) {
#if defined(__APPLE__)
    encoder_ = createVideoToolboxEncoder();
#endif
    if (!encoder_) {
      errorCode = "encoder_unavailable";
      error = "No hardware encoder on this platform.";
      return false;
    }
    encoder_->onAccessUnit = [this](EncodedAccessUnit &&unit) { onAccessUnit(std::move(unit)); };
  }
  if (!encoder_->configure(target, errorCode, error)) {
    encoderConfigured_ = false;
    return false;
  }
  target_ = target;
  encoderConfigured_ = true;
  keyframeWanted_.store(true);
  emitHelperEvent("{\"type\":\"pgm_encoder_configured\",\"width\":" + std::to_string(target.width) + ",\"height\":" +
                  std::to_string(target.height) + ",\"fps_num\":" + std::to_string(target.fpsNum) + ",\"fps_den\":" +
                  std::to_string(target.fpsDen) + ",\"bitrate_kbps\":" + std::to_string(target.bitrateKbps) + "}");
  return true;
}

void PgmEngine::onFrame(const CapturedFrame &frame) {
  capturedFrames_.fetch_add(1);
  bool statusChanged = false;
  VideoEncoder *encoder = nullptr;
  bool forceKey = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasInput_) {
      return;
    }
    const bool signalChanged = tracker_.onFrame(frame.width, frame.height, frame.pixelFormat, frame.captureNs);
    if (signalChanged) {
      emitHelperEvent("{\"type\":\"pgm_signal\",\"signal\":" + signalJson(tracker_.signal()) + "}");
      std::string code;
      std::string error;
      if (!ensureEncoderForSignalLocked(code, error) && !code.empty()) {
        setErrorLocked(code, error);
      } else if (!lastErrorCode_.empty() && code.empty()) {
        lastErrorCode_.clear();
        lastErrorMessage_.clear();
      }
      statusChanged = true;
    }
    if (!encoderConfigured_) {
      // Frame rate not measured yet (first frames) or encoder failed: nothing to encode into.
      std::string code;
      std::string error;
      if (ensureEncoderForSignalLocked(code, error)) {
        statusChanged = true;
      } else {
        droppedFrames_.fetch_add(1);
        if (!code.empty() && lastErrorCode_ != code) {
          setErrorLocked(code, error);
          statusChanged = true;
        }
      }
    }
    if (encoderConfigured_ && publisher_->viewerCount() > 0) {
      encoder = encoder_.get();
      forceKey = keyframeWanted_.exchange(false);
    }
  }
  if (encoder != nullptr) {
    if (!encoder->encode(frame, forceKey)) {
      droppedFrames_.fetch_add(1);
    }
  }
  if (statusChanged) {
    emitStatus();
  }
}

void PgmEngine::onAccessUnit(EncodedAccessUnit &&unit) {
  encodedFrames_.fetch_add(1);
  encodedBytes_.fetch_add(unit.annexB.size());
  publisher_->sendVideo(unit);
}

void PgmEngine::housekeeping() {
  uint64_t lastPerf = nowNs();
  uint64_t lastCaptured = 0;
  uint64_t lastEncoded = 0;
  uint64_t lastBytes = 0;
  while (running_.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    bool changed = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (hasInput_ && tracker_.onTick(nowNs())) {
        emitHelperEvent("{\"type\":\"pgm_signal\",\"signal\":" + signalJson(tracker_.signal()) + "}");
        changed = true;
      }
    }
    if (publisher_->reapDead() > 0) {
      changed = true;
    }
    const uint64_t now = nowNs();
    if (now - lastPerf >= 1'000'000'000ULL) {
      const double seconds = static_cast<double>(now - lastPerf) / 1e9;
      const uint64_t captured = capturedFrames_.load();
      const uint64_t encoded = encodedFrames_.load();
      const uint64_t bytes = encodedBytes_.load();
      {
        std::lock_guard<std::mutex> lock(mutex_);
        captureFps_ = static_cast<double>(captured - lastCaptured) / seconds;
        encodeFps_ = static_cast<double>(encoded - lastEncoded) / seconds;
        bitrateKbps_ = static_cast<double>(bytes - lastBytes) * 8.0 / 1000.0 / seconds;
      }
      lastCaptured = captured;
      lastEncoded = encoded;
      lastBytes = bytes;
      lastPerf = now;
      if (config_.logPerf) {
        emitHelperEvent("{\"type\":\"pgm_perf\",\"perf\":" + perfJson() + "}");
      }
    }
    if (changed) {
      emitStatus();
    }
  }
}

std::string PgmEngine::viewerOffer(const ViewerOfferRequest &request) {
  bool audio = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasInput_) {
      throw RpcFailure{"pgm_no_signal", "No program source is selected."};
    }
    audio = audioRunning_;
    if (!request.profile.empty()) {
      profile_ = parseEncodeProfile(request.profile);
    }
  }
  const std::string answer = publisher_->addViewer(request, audio);
  emitStatus();
  return answer;
}

void PgmEngine::viewerClose(const std::string &viewerId) {
  publisher_->removeViewer(viewerId);
  emitStatus();
}

}  // namespace broadify::pgm
