#include <sstream>
#include "keyer/keyer_chain.h"

#include <cstdlib>
#include <iostream>
#include <string>

#include "keyer/matting_backend.h"
#include "keyer/modnet_keyer.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"
#if defined(__APPLE__)
#include "keyer/coreml_keyer.h"
#include "keyer/vision_keyer.h"
#endif

namespace broadify::meeting {
namespace {

// Backend override (BROADIFY_MEETING_KEYER_BACKEND=modnet|vision_person_segmentation).
// Forces the keyer backend regardless of what the webapp requested — used to A/B
// the MODNet matting backend against Apple Vision on macOS without touching the
// UI. Empty/unset keeps the requested backend. "openvino_modnet" (the Windows
// OpenVINO force, consumed by the matting backend factory reading the same
// env) dispatches through the MODNet path here.
std::string readKeyerBackendOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_BACKEND");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  if (v == "openvino_modnet") {
    return "modnet";
  }
  return (v == "modnet" || v == "vision_person_segmentation" ||
          v == "coreml_modnet")
             ? v
             : "";
}

// Performance override (BROADIFY_MEETING_KEYER_PERFORMANCE=high_quality|balanced|
// performance). Drives the MODNet input resolution (512 / 320 / 256) so quality
// can be tested at full res regardless of what the webapp requested.
std::string readKeyerPerformanceOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_PERFORMANCE");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  return (v == "high_quality" || v == "balanced" || v == "performance") ? v : "";
}

#if defined(__APPLE__)
// Auto-quality thresholds: with inference above ~30ms the keyer cannot hold
// ~30fps with headroom, so the governor steps down to the "fast" tier (whose
// coarse masks the pipeline refines along the camera image afterwards).
constexpr double kAutoQualityMaxInferenceMs = 34.0;
constexpr uint64_t kAutoQualityMinSamples = 10u;
constexpr double kAutoQualityEmaWeight = 0.2;
// After degrading to "fast", periodically probe the better tier again: load
// spikes (exports, dev tooling) must not pin the session to coarse masks.
// The interval backs off exponentially so a machine that genuinely cannot hold
// "balanced" settles into "fast" instead of re-probing (and visibly wobbling
// quality) every minute; a probe that holds resets it to the base interval.
constexpr auto kAutoQualityBaseReprobeInterval = std::chrono::seconds(60);
constexpr auto kAutoQualityMaxReprobeInterval = std::chrono::seconds(600);
// Consecutive "balanced" samples that must pass without re-degrading before a
// probe counts as successful (~1s at 30fps).
constexpr uint64_t kAutoQualityStableSamples = 30u;

// Manual quality override (BROADIFY_MEETING_KEYER_QUALITY=balanced|fast). When
// set it pins the Vision tier and bypasses the auto-governor entirely — useful
// on machines where "balanced" inference exceeds the 30fps budget but the async
// pipeline still holds the program at 30fps via mask reuse, so the finer masks
// are worth the slightly slower refresh. Empty/unset keeps the auto behavior.
std::string readKeyerQualityOverride() {
  const char *value = std::getenv("BROADIFY_MEETING_KEYER_QUALITY");
  if (value == nullptr) {
    return "";
  }
  const std::string v(value);
  return (v == "balanced" || v == "fast") ? v : "";
}
#endif

std::string coarseDegradationStage(const std::string &stage) {
  if (stage == "fused_reused") {
    return "fused";
  }
  return stage;
}

}  // namespace

KeyerChain::KeyerChain(const Options &options)
    : options_{options.modelsDir},
      // Backend factory: the same createMattingKeyer call as the Windows
      // fused keyer in frame_pipeline.cpp, so both sites run the same
      // backend (ONNX Runtime, or OpenVINO where compiled in and selected).
      modnet_(createMattingKeyer(makeMattingBackendOptionsFromEnv(options_.modelsDir)))
#if defined(__APPLE__)
      ,
      vision_(std::make_unique<VisionKeyer>()),
      coreml_(std::make_unique<CoreMLKeyer>(options_.modelsDir))
#endif
{
  status_.activeKeyer = "passthrough";
  status_.backend = "passthrough";
  status_.fallbackActive = true;
  status_.fallbackReason = "keyer_disabled";
}

KeyerResult KeyerChain::process(const VideoFrame &input, const MeetingState &state) {
  bool enabled = false;
  std::string requestedModel;
  KeyerSettings settings;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    enabled = state.keyerEnabled;
    requestedModel = state.requestedKeyerModel;
    settings.qualityMode = state.qualityMode;
    settings.performanceMode = state.performanceMode;
    if (settings.performanceMode == "balanced") {
      settings.maxInputWidth = 960u;
      settings.maxInputHeight = 540u;
    } else if (settings.performanceMode == "performance") {
      settings.maxInputWidth = 640u;
      settings.maxInputHeight = 360u;
    }
    settings.maskErodePx = state.maskErodePx;
    settings.maskDilatePx = state.maskDilatePx;
    settings.maskFeatherPx = state.maskFeatherPx;
    settings.dynamicDilation = state.dynamicDilation;
    settings.temporalBlendEnabled = state.temporalBlendEnabled;
    settings.edgeStabilizationEnabled = state.edgeStabilizationEnabled;
    settings.edgeStabilizationStrength = state.edgeStabilizationStrength;
    settings.degradation = state.degradationSettings;
  }

  // Env override wins over the webapp's requested backend (read once, cached).
  static const std::string backendOverride = readKeyerBackendOverride();
  if (!backendOverride.empty()) {
    requestedModel = backendOverride;
  }
  static const std::string performanceOverride = readKeyerPerformanceOverride();
  if (!performanceOverride.empty()) {
    settings.performanceMode = performanceOverride;
  }
  // Governor floor (Windows async-lite): younger masks beat the small edge
  // detail of the larger input while masks are being reused across frames.
  // The explicit env pin above keeps priority for A/B measurements.
  if (performanceOverride.empty() &&
      governorPerformanceFloor_.load(std::memory_order_relaxed) &&
      settings.performanceMode != "performance") {
    settings.performanceMode = "performance";
    settings.maxInputWidth = 640u;
    settings.maxInputHeight = 360u;
  }

  std::lock_guard<std::mutex> lock(mutex_);
  if (!enabled) {
    KeyerResult result;
    status_.activeKeyer = "passthrough";
    status_.backend = "passthrough";
    status_.fallbackActive = true;
    status_.fallbackReason = "keyer_disabled";
    status_.inferenceMs = -1.0;
    status_.metrics = KeyerMetrics{};
#if defined(__APPLE__)
    autoVisionQuality_ = "balanced";
    autoInferenceEmaMs_ = -1.0;
    autoInferenceSamples_ = 0;
    autoQualityReprobeInterval_ = kAutoQualityBaseReprobeInterval;
    autoQualityProbing_ = false;
#endif
    result.status = status_;
    return result;
  }

  if (requestedModel == "modnet") {
    KeyerResult result = modnet_->apply(input, settings);
    status_ = result.status;
    return result;
  }

#if defined(__APPLE__)
  if (requestedModel == "coreml_modnet") {
    KeyerResult result = coreml_->apply(input, settings);
    status_ = result.status;
    return result;
  }
  if (requestedModel == "vision_person_segmentation") {
    // Manual override wins over the governor (read once, cached).
    static const std::string qualityOverride = readKeyerQualityOverride();
    if (!qualityOverride.empty()) {
      settings.qualityMode = qualityOverride;
      KeyerResult result = vision_->apply(input, settings);
      status_ = result.status;
      return result;
    }
    if (settings.performanceMode == "performance") {
      settings.qualityMode = "fast";
    } else if (settings.performanceMode == "balanced") {
      if (autoVisionQuality_ == "fast" &&
          std::chrono::steady_clock::now() - autoQualityDegradedAt_ >= autoQualityReprobeInterval_) {
        // Retry "balanced". This run is a probe: if it degrades again the
        // interval backs off; if it holds, the interval resets.
        autoVisionQuality_ = "balanced";
        autoInferenceEmaMs_ = -1.0;
        autoInferenceSamples_ = 0;
        autoQualityProbing_ = true;
      }
      settings.qualityMode = autoVisionQuality_;
    }
    KeyerResult result = vision_->apply(input, settings);
    if (settings.performanceMode == "balanced" && !result.status.fallbackActive &&
        result.status.qualityMode == "balanced" && result.status.inferenceMs > 0.0) {
      autoInferenceEmaMs_ = autoInferenceEmaMs_ < 0.0
          ? result.status.inferenceMs
          : kAutoQualityEmaWeight * result.status.inferenceMs +
              (1.0 - kAutoQualityEmaWeight) * autoInferenceEmaMs_;
      ++autoInferenceSamples_;
      if (autoInferenceSamples_ >= kAutoQualityMinSamples &&
          autoInferenceEmaMs_ > kAutoQualityMaxInferenceMs) {
        autoVisionQuality_ = "fast";
        autoQualityDegradedAt_ = std::chrono::steady_clock::now();
        if (autoQualityProbing_) {
          // The probe failed — this machine still cannot hold "balanced", so
          // wait longer before the next retry (doubling, capped) to stop the
          // per-minute quality wobble.
          autoQualityReprobeInterval_ = std::min<std::chrono::steady_clock::duration>(
              autoQualityReprobeInterval_ * 2, kAutoQualityMaxReprobeInterval);
        }
        autoQualityProbing_ = false;
      } else if (autoQualityProbing_ &&
                 autoInferenceSamples_ >= kAutoQualityStableSamples) {
        // The probe held: "balanced" is sustainable again (e.g. a load spike
        // passed), so return to prompt retries next time.
        autoQualityReprobeInterval_ = kAutoQualityBaseReprobeInterval;
        autoQualityProbing_ = false;
      }
    }
    status_ = result.status;
    return result;
  }
#endif

  {
    KeyerResult result;
    status_.activeKeyer = "passthrough";
    status_.backend = requestedModel;
    status_.fallbackActive = true;
    status_.fallbackReason = "unsupported_model";
    status_.inferenceMs = -1.0;
    status_.metrics = KeyerMetrics{};
    result.status = status_;
    return result;
  }
}

KeyerStatus KeyerChain::status() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return status_;
}

void updateMeetingKeyerStatus(MeetingState &state, const KeyerStatus &status) {
  std::lock_guard<std::mutex> lock(state.mutex);
  static std::string lastLoggedProvider;
  static std::string lastLoggedFallbackReason;
  // Signature includes adapter/queue/path and the (rounded) warmup probe, so
  // the one keyer_provider line in the events log answers WHICH silicon runs
  // the model, HOW it was attached, and what a session-build inference costs.
  const std::string providerSignature =
      status.provider + '|' + status.gpuAdapter + '|' + status.dmlQueue + '|' +
      status.dmlPath + '|' +
      std::to_string(static_cast<long long>(status.probeInferenceMs));
  if (providerSignature != lastLoggedProvider) {
    lastLoggedProvider = providerSignature;
    std::ostringstream providerEvent;
    providerEvent << "{\"type\":\"keyer_provider\",\"provider\":\""
                  << jsonEscape(status.provider) << "\",\"gpu_adapter\":\""
                  << jsonEscape(status.gpuAdapter) << "\",\"dml_queue\":\""
                  << jsonEscape(status.dmlQueue) << "\",\"dml_path\":\""
                  << jsonEscape(status.dmlPath) << "\",\"probe_ms\":"
                  << static_cast<long long>(status.probeInferenceMs)
                  << ",\"probe_ms_512\":"
                  << static_cast<long long>(status.probeInferenceMs512)
                  << "}";
    emitHelperEvent(providerEvent.str());
  }
  if (status.fallbackReason != lastLoggedFallbackReason) {
    lastLoggedFallbackReason = status.fallbackReason;
    emitHelperEvent("{\"type\":\"keyer_fallback_change\",\"fallback_reason\":\"" +
                    jsonEscape(status.fallbackReason) + "\"}");
  }
  state.activeKeyer = status.activeKeyer;
  state.fallbackActive = status.fallbackActive;
  state.fallbackReason = status.fallbackReason;
  state.keyerBackend = status.backend;
  state.activeQualityMode = status.qualityMode;
  state.provider = status.provider;
  state.gpuAdapter = status.gpuAdapter;
  state.dmlQueue = status.dmlQueue;
  state.dmlPath = status.dmlPath;
  state.modelPath = status.modelPath;
  state.inferenceMs = status.inferenceMs;
  state.keyerDegraded =
      status.fallbackActive && status.fallbackReason != "keyer_disabled";
  state.keyerReady =
      !status.fallbackActive ||
      (status.fallbackReason != "loading" &&
       status.fallbackReason != "not_loaded");
  state.modelHashOk = status.modelHashOk;
  KeyerMetrics mergedMetrics = status.metrics;
  mergedMetrics.cameraCopyMs = state.keyerMetrics.cameraCopyMs;
  mergedMetrics.cameraUploadMs = state.keyerMetrics.cameraUploadMs;
  mergedMetrics.frameOverheadMs = state.keyerMetrics.frameOverheadMs;
  mergedMetrics.budgetThresholdMs = state.keyerMetrics.budgetThresholdMs;
  mergedMetrics.prepassGpu = state.keyerMetrics.prepassGpu;
  mergedMetrics.maskAgeMs = state.keyerMetrics.maskAgeMs;
  mergedMetrics.maskAgeAvgMs = state.keyerMetrics.maskAgeAvgMs;
  mergedMetrics.keyerPublishToProgramMs = state.keyerMetrics.keyerPublishToProgramMs;
  mergedMetrics.programFrameIntervalMs = state.keyerMetrics.programFrameIntervalMs;
  mergedMetrics.programFrameMs = state.keyerMetrics.programFrameMs;
  mergedMetrics.mjpegEncodeMs = state.keyerMetrics.mjpegEncodeMs;
  mergedMetrics.programFps = state.keyerMetrics.programFps;
  mergedMetrics.cameraTextureUploads = state.keyerMetrics.cameraTextureUploads;
  mergedMetrics.stagingReadbackDepth = state.keyerMetrics.stagingReadbackDepth;
  state.keyerMetrics = mergedMetrics;
}

void setMeetingDegradationStage(MeetingState &state, const std::string &stage) {
  static std::string lastLoggedStage;
  const std::string coarseStage = coarseDegradationStage(stage);
  if (coarseStage != lastLoggedStage) {
    lastLoggedStage = coarseStage;
    emitHelperEvent("{\"type\":\"keyer_degradation_stage_change\","
                    "\"degradation_stage\":\"" + jsonEscape(coarseStage) + "\"}");
  }
  state.degradationStage = stage;
}

}  // namespace broadify::meeting
