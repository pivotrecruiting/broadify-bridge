#pragma once

#include "audio/audio_source.h"
#include "audio/opus_encoder.h"
#include "capture/video_source.h"
#include "control/pgm_rpc.h"
#include "live_stream/video_encoder.h"
#include "recorder/mp4_recorder.h"
#include "recorder/recording_signal_gate.h"
#include "signal/video_signal_tracker.h"
#include "live_stream/publisher.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace broadify::pgm {

struct PgmEngineConfig {
  std::string syntheticSource;  // "WxH@fps" or empty
  bool logPerf = false;
};

/**
 * Owns capture → signal tracker → hardware encoder → WebRTC publisher (+ audio)
 * and, while recording, a second hardware encoder (H.264 High archive target,
 * ADR-0006) → MP4 passthrough recorder. Implements the RPC surface. Threads:
 * capture callbacks (AVFoundation queue / synthetic thread), encoder output
 * (VideoToolbox, one thread per session), a 500 ms housekeeping thread
 * (no-signal, dead viewers, perf events). State changes emit helper events so
 * the bridge can publish `pgm_status` without polling.
 */
class PgmEngine final : public PgmEngineApi {
 public:
  explicit PgmEngine(PgmEngineConfig config);
  ~PgmEngine() override;

  void start();
  void stop();

  // PgmEngineApi
  std::string inputsListJson() override;
  std::string statusJson() override;
  std::string perfJson() override;
  std::string sessionsJson() override;
  void selectSource(const std::string &inputId, const std::string &profile) override;
  void clearSource() override;
  std::string viewerOffer(const ViewerOfferRequest &request) override;
  void viewerClose(const std::string &viewerId) override;
  std::string recordingStart(const std::string &filePath) override;
  std::string recordingStop() override;
  std::string recordingStatusJson() override;
  std::string snapshotJson(double quality) override;

 private:
  void onFrame(const CapturedFrame &frame);
  void onAccessUnit(EncodedAccessUnit &&unit);
  void onRecordingAccessUnit(EncodedAccessUnit &&unit);
  void housekeeping();
  bool ensureEncoderForSignalLocked(std::string &errorCode, std::string &error);
  void setErrorLocked(const std::string &code, const std::string &message);
  std::string stateLocked() const;
  std::string statusJsonLocked() const;
  void emitStatus();
  void startAudioLocked(const std::string &displayName);
  void stopAudioLocked();
  std::string recordingJsonLocked() const;
  std::string recordingEncoderJsonLocked() const;
  /** Flushes the recording encoder into the recorder, stops the recorder, destroys the encoder. */
  bool finishRecording(std::string &error, bool &wasActive);
  void emitRecordingStopped(bool ok, const std::string &error);
  void keepLatestFrameLocked(const CapturedFrame &frame);

  PgmEngineConfig config_;
  std::unique_ptr<VideoInputEnumerator> enumerator_;
  std::unique_ptr<VideoSource> source_;
  std::unique_ptr<VideoEncoder> encoder_;
  /** Shared so the capture thread's in-flight encode() outlives a concurrent stop. */
  std::shared_ptr<VideoEncoder> recordingEncoder_;
  std::unique_ptr<AudioSource> audioSource_;
  std::unique_ptr<OpusAudioEncoder> opus_;
  std::unique_ptr<WebRtcPublisher> publisher_;
  Mp4Recorder recorder_;
#if defined(__APPLE__)
  CVPixelBufferRef latestFrame_ = nullptr;  // retained; snapshots
#endif
  VideoSignalTracker tracker_;
  EncodeTarget target_;
  EncodeTarget recordingTarget_;
  VideoSignal recordingSignal_;
  RecordingSignalGate recordingGate_;
  EncodeProfile profile_ = EncodeProfile::Auto;
  VideoInputInfo input_;
  bool hasInput_ = false;
  bool encoderConfigured_ = false;
  bool audioRunning_ = false;
  std::string lastErrorCode_;
  std::string lastErrorMessage_;
  std::atomic<bool> keyframeWanted_{false};
  std::atomic<bool> running_{false};
  std::thread housekeeping_;
  // perf counters (last second)
  std::atomic<uint64_t> capturedFrames_{0};
  std::atomic<uint64_t> encodedFrames_{0};
  std::atomic<uint64_t> droppedFrames_{0};
  std::atomic<uint64_t> encodedBytes_{0};
  std::atomic<uint64_t> recordingFrames_{0};
  std::atomic<uint64_t> recordingBytes_{0};
  std::atomic<uint64_t> recordingDropped_{0};
  double captureFps_ = 0.0;
  double encodeFps_ = 0.0;
  double bitrateKbps_ = 0.0;
  double recordingFps_ = 0.0;
  double recordingKbps_ = 0.0;
  mutable std::mutex mutex_;
};

}  // namespace broadify::pgm
