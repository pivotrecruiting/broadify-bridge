#include "pgm_engine.h"

#include "capture/snapshot.h"
#include "live_stream/monotonic_clock.h"
#include "common/pgm_options.h"
#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#include <chrono>
#include <sstream>

namespace broadify::pgm {

using broadify::helper::emitHelperEvent;
using broadify::helper::jsonEscape;

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
#if defined(__APPLE__)
  std::lock_guard<std::mutex> lock(mutex_);
  if (latestFrame_ != nullptr) {
    CFRelease(latestFrame_);
    latestFrame_ = nullptr;
  }
#endif
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
  out << ",\"audio\":" << (audioRunning_ ? "true" : "false") << ",\"viewers\":" << publisher_->viewerCount()
      << ",\"recording\":" << recordingJsonLocked() << ",\"last_error\":";
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
      << ",\"dropped\":" << droppedFrames_.load() << ",\"viewers\":" << publisher_->viewerCount() << ",\"recording_fps\":"
      << recordingFps_ << ",\"recording_kbps\":" << recordingKbps_ << ",\"recording_dropped\":" << recordingDropped_.load() << "}";
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
  std::string recordingError;
  bool recordingWasActive = false;
  const bool recordingOk = finishRecording(recordingError, recordingWasActive);
  if (recordingWasActive) {
    emitRecordingStopped(recordingOk, recordingError);
  }
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
#if defined(__APPLE__)
        recorder_.appendAudio(chunk.sample);
#endif
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
  std::shared_ptr<VideoEncoder> recordingEncoder;
  RecordingGateDecision recording;
  bool recordingFpsChanged = false;
  std::string signalForEvent;
  std::string recordingForEvent;
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
    keepLatestFrameLocked(frame);
    // Live preview: viewers only. The recording no longer keeps this encoder running (ADR-0006).
    if (RecordingSignalGate::shouldEncodePreview(publisher_->viewerCount(), encoderConfigured_)) {
      encoder = encoder_.get();
      forceKey = keyframeWanted_.exchange(false);
    }
    if (recordingEncoder_) {
      recording = recordingGate_.onFrame(frame.width, frame.height, frame.pixelFormat);
      if (signalChanged) {
        recordingFpsChanged = recordingGate_.fpsChanged(tracker_.signal().fpsNum, tracker_.signal().fpsDen);
      }
      if (recording.encode) {
        recordingEncoder = recordingEncoder_;
      }
      if (recording.mismatchStarted || recording.mismatchEnded || recordingFpsChanged) {
        signalForEvent = signalJson(tracker_.signal());
        // The geometry the recording is bound to, including the pixel format the gate compares against.
        recordingForEvent = recordingEncoderJsonLocked();
        recordingForEvent.back() = ',';
        recordingForEvent += "\"pixel_format\":\"" + jsonEscape(recordingSignal_.pixelFormat) + "\"}";
      }
    }
  }
  if (encoder != nullptr) {
    if (!encoder->encode(frame, forceKey)) {
      droppedFrames_.fetch_add(1);
    }
  }
  if (recordingEncoder) {
    if (!recordingEncoder->encode(frame, recording.forceKeyframe)) {
      recordingDropped_.fetch_add(1);
    }
  }
  if (recording.mismatchStarted || recording.mismatchEnded) {
    // Signal change during a recording is a gap, the file stays valid: frames
    // are skipped until the start geometry returns (then a forced keyframe).
    emitHelperEvent(std::string("{\"type\":\"pgm_recording_signal_mismatch\",\"phase\":\"") +
                    (recording.mismatchStarted ? "started" : "ended") + "\",\"signal\":" + signalForEvent +
                    ",\"recording\":" + recordingForEvent + "}");
  }
  if (recordingFpsChanged) {
    emitHelperEvent("{\"type\":\"pgm_recording_fps_changed\",\"signal\":" + signalForEvent + "}");
  }
  if (statusChanged) {
    emitStatus();
  }
}

void PgmEngine::onAccessUnit(EncodedAccessUnit &&unit) {
  encodedFrames_.fetch_add(1);
  encodedBytes_.fetch_add(unit.annexB.size());
  publisher_->sendVideo(unit);
#if defined(__APPLE__)
  if (unit.sample != nullptr) {
    CFRelease(unit.sample);
    unit.sample = nullptr;
  }
#endif
}

void PgmEngine::onRecordingAccessUnit(EncodedAccessUnit &&unit) {
  recordingFrames_.fetch_add(1);
  recordingBytes_.fetch_add(unit.annexB.size());
#if defined(__APPLE__)
  if (unit.sample != nullptr) {
    recorder_.appendVideo(unit.sample, unit.keyframe);
    CFRelease(unit.sample);
    unit.sample = nullptr;
  }
#endif
}

void PgmEngine::keepLatestFrameLocked(const CapturedFrame &frame) {
#if defined(__APPLE__)
  if (frame.pixelBuffer == nullptr) {
    return;
  }
  CVPixelBufferRef previous = latestFrame_;
  CFRetain(frame.pixelBuffer);
  latestFrame_ = frame.pixelBuffer;
  if (previous != nullptr) {
    CFRelease(previous);
  }
#else
  (void)frame;
#endif
}

std::string PgmEngine::recordingEncoderJsonLocked() const {
  std::ostringstream out;
  out << "{\"profile\":\"" << (recordingTarget_.h264Profile == H264Profile::High ? "high" : "main") << "\",\"bitrate_kbps\":"
      << recordingTarget_.bitrateKbps << ",\"width\":" << recordingTarget_.width << ",\"height\":" << recordingTarget_.height
      << ",\"fps_num\":" << recordingTarget_.fpsNum << ",\"fps_den\":" << recordingTarget_.fpsDen << "}";
  return out.str();
}

std::string PgmEngine::recordingJsonLocked() const {
  const RecordingStatus rec = recorder_.status();
  std::ostringstream out;
  out << "{\"active\":" << (rec.active ? "true" : "false") << ",\"file_path\":"
      << (rec.filePath.empty() ? "null" : "\"" + jsonEscape(rec.filePath) + "\"") << ",\"started_at_ms\":"
      << (rec.active ? std::to_string(rec.startedAtMs) : "null") << ",\"bytes\":" << rec.bytes << ",\"error\":"
      << (rec.error.empty() ? "null" : "\"" + jsonEscape(rec.error) + "\"");
  if (rec.active && recordingEncoder_) {
    out << ",\"profile\":\"" << (recordingTarget_.h264Profile == H264Profile::High ? "high" : "main") << "\",\"bitrate_kbps\":"
        << recordingTarget_.bitrateKbps << ",\"width\":" << recordingTarget_.width << ",\"height\":" << recordingTarget_.height
        << ",\"fps_num\":" << recordingTarget_.fpsNum << ",\"fps_den\":" << recordingTarget_.fpsDen << ",\"frames\":"
        << recordingFrames_.load();
  }
  out << "}";
  return out.str();
}

std::string PgmEngine::recordingStart(const std::string &filePath) {
  bool audio = false;
  VideoSignal signal;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasInput_) {
      throw RpcFailure{"pgm_no_signal", "No program source is selected."};
    }
    if (recordingEncoder_ || recorder_.isActive()) {
      throw RpcFailure{"recording_failed", "A recording is already running."};
    }
    signal = tracker_.signal();
    if (signal.noSignal || signal.width == 0 || signal.fpsNum == 0) {
      throw RpcFailure{"pgm_no_signal", "The program signal is not measured yet."};
    }
    audio = audioRunning_;
  }
  // Own archive encoder (ADR-0006): H.264 High at the recorder policy bitrate,
  // source geometry at the source rate, independent of the viewer profile.
  // Created and configured outside mutex_ so the session setup never stalls
  // the capture queue; hardware only, failure surfaces as encoder_unavailable.
  const EncodeTarget target = selectRecordingTarget(signal.width, signal.height, signal.fpsNum, signal.fpsDen);
  std::shared_ptr<VideoEncoder> encoder;
#if defined(__APPLE__)
  encoder = createVideoToolboxEncoder();
#endif
  if (!encoder) {
    throw RpcFailure{"encoder_unavailable", "No hardware encoder on this platform."};
  }
  encoder->onAccessUnit = [this](EncodedAccessUnit &&unit) { onRecordingAccessUnit(std::move(unit)); };
  std::string code;
  std::string error;
  if (!encoder->configure(target, code, error)) {
    throw RpcFailure{code.empty() ? "encoder_unavailable" : code, error};
  }
  if (!recorder_.start(filePath, audio, error)) {
    throw RpcFailure{"recording_failed", error};
  }
  std::string recordingJson;
  std::string encoderJson;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    recordingTarget_ = target;
    recordingSignal_ = signal;
    recordingGate_.arm(signal.width, signal.height, signal.pixelFormat, signal.fpsNum, signal.fpsDen);
    recordingFrames_.store(0);
    recordingBytes_.store(0);
    recordingDropped_.store(0);
    recordingFps_ = 0.0;
    recordingKbps_ = 0.0;
    encoder->requestKeyframe();  // the file opens on this IDR
    recordingEncoder_ = std::move(encoder);
    encoderJson = recordingEncoderJsonLocked();
    recordingJson = recordingJsonLocked();
  }
  // Event fields mirror pgm_status.recording so the bridge can merge them without a status round trip.
  emitHelperEvent("{\"type\":\"pgm_recording\",\"active\":true,\"file_path\":\"" + jsonEscape(filePath) + "\"," +
                  encoderJson.substr(1));
  emitStatus();
  return recordingJson;
}

bool PgmEngine::finishRecording(std::string &error, bool &wasActive) {
  std::shared_ptr<VideoEncoder> encoder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    encoder = std::move(recordingEncoder_);
    recordingGate_.reset();
  }
  wasActive = recorder_.isActive();
  if (encoder) {
    // Synchronous: every pending access unit reaches the recorder before it closes the file.
    encoder->flush();
  }
  const bool ok = recorder_.stop(error);
  encoder.reset();
  return ok;
}

void PgmEngine::emitRecordingStopped(bool ok, const std::string &error) {
  emitHelperEvent(std::string("{\"type\":\"pgm_recording\",\"active\":false,\"ok\":") + (ok ? "true" : "false") + ",\"error\":" +
                  (error.empty() ? "null" : "\"" + jsonEscape(error) + "\"") + "}");
}

std::string PgmEngine::recordingStop() {
  std::string error;
  bool wasActive = false;
  const bool ok = finishRecording(error, wasActive);
  emitRecordingStopped(ok, error);
  emitStatus();
  if (!ok) {
    throw RpcFailure{"recording_failed", error};
  }
  std::lock_guard<std::mutex> lock(mutex_);
  return recordingJsonLocked();
}

std::string PgmEngine::recordingStatusJson() {
  std::lock_guard<std::mutex> lock(mutex_);
  return recordingJsonLocked();
}

std::string PgmEngine::snapshotJson(double quality) {
#if defined(__APPLE__)
  CVPixelBufferRef frame = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (latestFrame_ != nullptr) {
      CFRetain(latestFrame_);
      frame = latestFrame_;
    }
  }
  if (frame == nullptr) {
    throw RpcFailure{"pgm_no_signal", "No frame has arrived yet."};
  }
  uint32_t width = 0;
  uint32_t height = 0;
  const double clamped = quality < 0.3 ? 0.3 : (quality > 0.95 ? 0.95 : quality);
  const std::string base64 = jpegBase64FromPixelBuffer(frame, clamped, width, height);
  CFRelease(frame);
  if (base64.empty()) {
    throw RpcFailure{"snapshot_failed", "The frame could not be encoded as JPEG."};
  }
  return "{\"jpeg_base64\":\"" + base64 + "\",\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) +
         ",\"captured_at_ms\":" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()) + "}";
#else
  (void)quality;
  throw RpcFailure{"snapshot_failed", "Snapshots are not available on this platform."};
#endif
}

void PgmEngine::housekeeping() {
  uint64_t lastPerf = monotonicNowNs();
  uint64_t lastCaptured = 0;
  uint64_t lastEncoded = 0;
  uint64_t lastBytes = 0;
  uint64_t lastRecordingFrames = 0;
  uint64_t lastRecordingBytes = 0;
  while (running_.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    bool changed = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (hasInput_ && tracker_.onTick(monotonicNowNs())) {
        emitHelperEvent("{\"type\":\"pgm_signal\",\"signal\":" + signalJson(tracker_.signal()) + "}");
        changed = true;
      }
    }
    if (publisher_->reapDead() > 0) {
      changed = true;
    }
    const uint64_t now = monotonicNowNs();
    if (now - lastPerf >= 1'000'000'000ULL) {
      const double seconds = static_cast<double>(now - lastPerf) / 1e9;
      const uint64_t captured = capturedFrames_.load();
      const uint64_t encoded = encodedFrames_.load();
      const uint64_t bytes = encodedBytes_.load();
      const uint64_t recordingFrames = recordingFrames_.load();
      const uint64_t recordingBytes = recordingBytes_.load();
      {
        std::lock_guard<std::mutex> lock(mutex_);
        captureFps_ = static_cast<double>(captured - lastCaptured) / seconds;
        encodeFps_ = static_cast<double>(encoded - lastEncoded) / seconds;
        bitrateKbps_ = static_cast<double>(bytes - lastBytes) * 8.0 / 1000.0 / seconds;
        // Counters restart at zero with every recording; a lower value means a new recording began.
        recordingFps_ = recordingFrames >= lastRecordingFrames ? static_cast<double>(recordingFrames - lastRecordingFrames) / seconds : 0.0;
        recordingKbps_ = recordingBytes >= lastRecordingBytes ? static_cast<double>(recordingBytes - lastRecordingBytes) * 8.0 / 1000.0 / seconds : 0.0;
      }
      lastCaptured = captured;
      lastEncoded = encoded;
      lastBytes = bytes;
      lastRecordingFrames = recordingFrames;
      lastRecordingBytes = recordingBytes;
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
