#include "pipeline/frame_pipeline.h"

#include "compose/compositor.h"
#include "director/auto_director.h"
#include "framebus_reader.h"
#include "framebus_writer.h"
#include "keyer/coreml_keyer.h"
#include "keyer/keyer_chain.h"
#include "keyer/keyer_governor.h"
#include "keyer/matting_backend.h"
#include "keyer/modnet_keyer.h"
#include "pipeline/framebus_reader_log_gate.h"
#include "pipeline/compositor_input_selection.h"
#include "pipeline/frame_pipeline_gating.h"
#include "pipeline/guided_mask_refine.h"
#include "pipeline/keyer_cadence.h"
#include "pipeline/subject_presence.h"
#if defined(_WIN32)
#include "compose/d3d11_compositor.h"
#include "pipeline/mask_retention.h"
#include "pipeline/tier_handover.h"
#endif
#include "recorder/meeting_recorder.h"
#include "util/json_utils.h"
#include "util/win_qos.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace broadify::meeting {
namespace {

constexpr uint32_t kSlotCount = 3;
constexpr uint32_t kMaxAlphaDilateRadiusPx = 8;
constexpr uint32_t kMaxAlphaFeatherRadiusPx = 3;
// Morphological close (dilate then erode, same radius) run first in
// postprocessing: fills small background pinholes inside the foreground
// silhouette ("holes in the background") without net-growing the outline.
constexpr uint32_t kMaskCloseRadiusPx = 2;
constexpr uint32_t kTemporalProtectionRadiusPx = 10;
constexpr uint8_t kTemporalProtectionAlphaThreshold = 32;
constexpr uint64_t kTemporalAlphaMaxAgeNs = 250000000u;
constexpr double kStaleMaskAgeMs = 140.0;
// Softened low cutoff: 0.12 discarded faint hair/edge alpha before it ever
// reached the compositor. 0.08 keeps more of the soft band (Fix 4).
constexpr float kSmoothstepLow = 0.08f;
constexpr float kSmoothstepHigh = 0.88f;
constexpr float kQuietPreviousWeight = 0.85f;
constexpr float kMotionPreviousWeight = 0.35f;
constexpr float kStalePreviousWeight = 0.12f;
constexpr uint8_t kEdgeStabilizationAlphaLow = 24u;
constexpr uint8_t kEdgeStabilizationAlphaHigh = 220u;
constexpr float kEdgeStabilizationMaxMotion = 0.55f;
constexpr double kEdgeStabilizationFreshAgeMs = 40.0;
constexpr double kEdgeStabilizationFadeOutAgeMs = 75.0;
constexpr float kEdgeStabilizationMinAgeFactor = 0.12f;
constexpr const char *kMeetingBackGraphicsFrameBusName = "bfy-meet-gfx-back";
constexpr const char *kMeetingFrontGraphicsFrameBusName = "bfy-meet-gfx-front";
constexpr double kMetricsWindowMs = 1000.0;
constexpr size_t kMaskAgeWindowSize = 30u;
// Joint bilateral upsampling of coarse segmentation masks: only masks below
// this width get refined (Vision "fast" delivers 256px; "balanced" 512px
// masks are already fine and would double the refinement cost).
constexpr uint32_t kMaskRefineMaxSourceWidthPx = 400u;
constexpr int kMaskRefineRadiusPx = 2;
constexpr float kMaskRefineSpatialSigmaPx = 1.0f;
constexpr float kMaskRefineRangeSigmaLuma = 14.0f;
constexpr auto kIdleSleep = std::chrono::milliseconds(1000);
constexpr auto kStaticPollInterval = std::chrono::milliseconds(100);
constexpr auto kStaticHeartbeatInterval = std::chrono::milliseconds(1000);
constexpr auto kCameraStallWindow = std::chrono::milliseconds(1500);
// Duty-cycle guard: only when one keyer pass clearly exceeds a camera frame
// interval (1.5x, i.e. the machine sustains at most ~20fps anyway) insert a
// cooldown of this fraction of the pass duration, so weak machines keep ~20%
// idle headroom instead of running at full load. Borderline machines that
// almost keep camera rate must not be penalized.
constexpr double kKeyerCooldownTriggerFactor = 1.5;
constexpr double kKeyerCooldownFraction = 0.25;
constexpr double kKeyerMaxCooldownMs = 50.0;

// Mask-collapse guard: Apple Vision intermittently returns a (near-)empty mask
// under backlight / bad contrast, which would key the whole person out. We
// measure the raw foreground coverage and, if a mask collapses, keep serving
// the last good mask instead of publishing the broken one. The program loop's
// mask-age limit bounds this hold, so a genuinely absent person still falls
// back to the un-keyed camera rather than freezing forever.
constexpr uint8_t kCoverageAlphaThreshold = 64u;   // counts as "foreground"
constexpr double kMinForegroundCoverage = 0.006;   // below = essentially empty
constexpr double kHealthyCoverage = 0.05;          // last mask was a real person
constexpr double kCollapseDropRatio = 0.28;        // sudden drop below this = collapse
// Upper guard (symmetric to the empty-mask guard): a low-confidence frame can
// make Vision emit a near-full-frame foreground mask ("whole background stops
// keying"). Above this coverage the mask is treated as a dropout and the last
// good pair is held instead. Set high so a subject genuinely filling the frame
// is not misclassified. The keyer also resets its temporal state on this event
// so the next frame re-converges.
constexpr double kMaxForegroundCoverage = 0.98;

// Motion-adaptive temporal EMA: the current frame's weight scales with how much
// the mask changed since the last frame. When the subject is still we lean on
// the previous mask (strong smoothing, kills flicker); when they move we nearly
// pass the current mask through (minimal lag). This removes the trailing latency
// a fixed low weight caused while keeping the anti-flicker/region-restore
// benefit. meanDiff is the mean absolute alpha change (0..255) vs the previous.
constexpr float kEmaWeightStatic = 0.55f;   // still subject -> smooth
constexpr float kEmaWeightMotion = 0.9f;    // moving subject -> low latency
constexpr double kEmaMotionLow = 6.0;       // meanDiff below this = static
constexpr double kEmaMotionHigh = 30.0;     // meanDiff above this = clear motion

// True full-frame temporal EMA: mask = w*current + (1-w)*previous. Unlike the
// edge-gated blend it mixes the whole frame, so it both suppresses flicker and
// restores regions the current frame dropped. Resamples the previous mask
// (nearest) when the quality tier changed its resolution, so smoothing is not
// skipped at tier transitions.
void blendAlphaEma(AlphaMask &mask, const AlphaMask &previous,
                   float staticWeight = kEmaWeightStatic,
                   float motionWeight = kEmaWeightMotion) {
  if (mask.alpha.empty() || previous.alpha.empty() || mask.width == 0u ||
      mask.height == 0u) {
    return;
  }
  const bool sameSize =
      previous.width == mask.width && previous.height == mask.height;
  // Reads the previous mask at the current mask's (x,y), resampling (nearest)
  // when the quality tier changed the resolution.
  const auto prevAt = [&](uint32_t x, uint32_t y) -> int {
    size_t index;
    if (sameSize) {
      index = static_cast<size_t>(y) * mask.width + x;
    } else {
      const uint32_t py = static_cast<uint32_t>(
          (static_cast<uint64_t>(y) * previous.height) / mask.height);
      const uint32_t px = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * previous.width) / mask.width);
      index = static_cast<size_t>(py) * previous.width + px;
    }
    return index < previous.alpha.size() ? previous.alpha[index] : 0;
  };

  // 1) Motion metric: mean absolute alpha change vs the previous mask.
  double sumDiff = 0.0;
  size_t count = 0;
  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      const size_t di = static_cast<size_t>(y) * mask.width + x;
      if (di >= mask.alpha.size()) {
        continue;
      }
      sumDiff += std::abs(static_cast<int>(mask.alpha[di]) - prevAt(x, y));
      ++count;
    }
  }
  const double meanDiff = count > 0 ? sumDiff / static_cast<double>(count) : 0.0;

  // 2) Adaptive current-frame weight: smooth when static, responsive on motion.
  const double t = std::clamp(
      (meanDiff - kEmaMotionLow) / (kEmaMotionHigh - kEmaMotionLow), 0.0, 1.0);
  const float wCur = static_cast<float>(
      staticWeight + t * (motionWeight - staticWeight));
  const float wPrev = 1.0f - wCur;

  // 3) Blend.
  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      const size_t di = static_cast<size_t>(y) * mask.width + x;
      if (di >= mask.alpha.size()) {
        continue;
      }
      mask.alpha[di] = static_cast<uint8_t>(
          wCur * mask.alpha[di] + wPrev * prevAt(x, y) + 0.5f);
    }
  }
}

// Fraction of the mask that is confidently foreground (raw, pre-postprocessing).
double computeMaskCoverage(const AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return 0.0;
  }
  size_t foreground = 0u;
  for (const uint8_t a : mask.alpha) {
    if (a >= kCoverageAlphaThreshold) {
      ++foreground;
    }
  }
  return static_cast<double>(foreground) / static_cast<double>(mask.alpha.size());
}

// Empty-subject handling kill-switch (default ON). When enabled, a coverage
// collapse that persists across acceptAfterMs of SUCCESSFUL inference is
// accepted as "the person left the frame": the empty mask is passed through
// flagged as valid so the composited background stays up (Option A). Set
// BROADIFY_MEETING_EMPTY_SUBJECT=0 to restore the previous behavior
// end-to-end (hold/oscillate; compositor falls back to the un-keyed camera).
// Read once, like gpuPipelineEnabled.
bool emptySubjectEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_EMPTY_SUBJECT");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
}

SubjectPresenceConfig subjectPresenceConfigFromEnv() {
  SubjectPresenceConfig config;
  config.enabled = emptySubjectEnabled();
  return config;
}

// Presence tracker for the fused (synchronous) keyer paths. Program-loop
// thread only, like the other fused statics; reset together with the fused
// path state on Windows path transitions.
SubjectPresenceTracker &fusedSubjectPresenceTracker() {
  static SubjectPresenceTracker tracker(subjectPresenceConfigFromEnv());
  return tracker;
}

double steadyNowMs() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

// Mutable temporal state of stabilizeFusedMask, hoisted out of the function
// so keyer path transitions can reset it: as function-locals these survived
// tier transitions, letting the collapse guard compare against - and
// substitute, for up to kMaxFusedCollapseHold frames - a minutes-old mask
// after e.g. a lite->fused step-up. Program-loop thread only, like the other
// fused statics.
struct FusedStabilizerState {
  AlphaMask prevMask;
  double prevCoverage = 0.0;
  int collapseHold = 0;
  void reset() {
    prevMask = AlphaMask{};
    prevCoverage = 0.0;
    collapseHold = 0;
  }
};

FusedStabilizerState &fusedStabilizerState() {
  static FusedStabilizerState state;
  return state;
}

// Temporal stabilization for the fused (mask-age-0) matte, shared by the
// macOS and Windows fused paths (KEY-03 - this used to live only in the
// Windows branch). The collapse guard bridges model dropouts for a bounded
// number of frames ("person briefly gone" stays invisible); the optional
// motion-adaptive EMA smooths per-frame confidence flicker. macOS passes
// applyEma=false so its tuned raw-matte look stays unchanged while still
// gaining the dropout protection. Only called from the program-loop thread.
void stabilizeFusedMask(AlphaMask &fusedMask, bool applyEma) {
  AlphaMask &prevFusedMask = fusedStabilizerState().prevMask;
  double &prevFusedCoverage = fusedStabilizerState().prevCoverage;
  int &fusedCollapseHold = fusedStabilizerState().collapseHold;
  constexpr int kMaxFusedCollapseHold = 12;  // ~0.4s at 30fps
  const double fusedCoverage = computeMaskCoverage(fusedMask);
  // Subject-presence tracking (Option A): only ever called on SUCCESSFUL
  // fused inference, so every feed counts towards the empty streak. When the
  // person verifiably left (confirmed over acceptAfterMs), pass the empty
  // matte through flagged as valid instead of the bounded hold expiring into
  // an anchor-less mask (which flapped to the un-keyed camera). Shared with
  // macOS BY DESIGN: the same latent bug exists there - macOS only ever
  // "worked" via residual matte noise keeping the anchor alive.
  const SubjectPresence presence = fusedSubjectPresenceTracker().feed(
      fusedCoverage, /*inferenceSucceeded=*/true, steadyNowMs());
  if (presence == SubjectPresence::ConfirmedEmpty &&
      fusedCoverage < kMinForegroundCoverage) {
    fusedMask.emptyValid = true;
    fusedCollapseHold = 0;
    prevFusedMask = fusedMask;
    prevFusedCoverage = fusedCoverage;
    return;
  }
  const bool fusedCollapsed =
      fusedCoverage < kMinForegroundCoverage ||
      fusedCoverage > kMaxForegroundCoverage ||
      (prevFusedCoverage > kHealthyCoverage &&
       fusedCoverage < prevFusedCoverage * kCollapseDropRatio);
  if (fusedCollapsed && !prevFusedMask.alpha.empty() &&
      fusedCollapseHold < kMaxFusedCollapseHold) {
    fusedMask = prevFusedMask;
    ++fusedCollapseHold;
    return;
  }
  fusedCollapseHold = 0;
  if (applyEma && !prevFusedMask.alpha.empty() &&
      fusedCoverage >= kMinForegroundCoverage &&
      fusedCoverage <= kMaxForegroundCoverage) {
    // Lighter EMA than the async path: the fused matte is age-0, so it needs
    // less smoothing -> less body trail while still killing the per-frame
    // flicker. Env-tunable to dial the flicker/ghost trade-off without a
    // rebuild (higher = crisper/less ghost).
    static const float fusedEmaStatic = [] {
      const char *raw = std::getenv("BROADIFY_MEETING_FUSED_EMA_STATIC");
      return raw != nullptr ? static_cast<float>(std::atof(raw)) : 0.72f;
    }();
    static const float fusedEmaMotion = [] {
      const char *raw = std::getenv("BROADIFY_MEETING_FUSED_EMA_MOTION");
      return raw != nullptr ? static_cast<float>(std::atof(raw)) : 0.96f;
    }();
    blendAlphaEma(fusedMask, prevFusedMask, fusedEmaStatic, fusedEmaMotion);
  }
  prevFusedMask = fusedMask;
  prevFusedCoverage = fusedCoverage;
}

// Set by the fused keyer blocks in the program loop: true while the fused GPU
// keyer reports fallback (model missing/compile failed/...). While degraded,
// the loop feeds the async worker again so the Vision/async fallback actually
// receives frames - previously the submit guard starved it and a fused
// failure froze the keyer silently (K-03). Program-loop thread only.
bool g_fusedKeyerDegraded = false;

// True while the Windows fused path is bridging a step-down Overlap (the
// fused keyer stays ON AIR while the async worker warms up). Mirrored from
// TierHandover::phase() at the end of the fused section each frame; the async
// telemetry blocks run EARLIER in the loop iteration (and cannot see the
// fused section's static handover), so they read the previous frame's phase
// here and skip their per-frame telemetry writes while it is set — otherwise
// UI polls could sample degradationStage "passthrough"/keyerFps from the
// warming worker while the fused keyer is what actually composites.
// Program-loop thread only, like g_fusedKeyerDegraded.
bool g_fusedStepDownOverlapActive = false;

// Live-frame edge-snap toggle (default ON). The keyer publishes a mask paired
// with the OLD frame it was computed on; compositing that old frame is the
// source of the visible latency on motion. When enabled, the program loop
// instead composites the LIVE camera frame and snaps the (slightly old) mask
// onto its real edges with the guided filter — removing both the latency and the
// boundary flicker. Set BROADIFY_MEETING_LIVE_SNAP=0 to A/B against the old path.
bool liveSnapEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_LIVE_SNAP");
    return raw == nullptr || raw[0] == '\0' || raw[0] != '0';
  }();
  return enabled;
}

// Fused synchronous GPU keyer path (default OFF). When enabled the program loop
// computes the mask on the CURRENT frame via the native CoreML keyer instead of
// consuming the async worker's older mask, driving mask age to zero (kills the
// motion edge-lag). Falls back to the async path on any failure.
bool gpuPipelineEnabled() {
#if defined(__APPLE__)
  static const bool enabled = [] {
    // Default ON: the fused synchronous native-CoreML/GPU keyer is the production
    // path (mask age 0 -> motion edges track exactly). Kill-switch: set
    // BROADIFY_MEETING_GPU_PIPELINE=0 to fall back to the async Vision keyer.
    const char *raw = std::getenv("BROADIFY_MEETING_GPU_PIPELINE");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
#elif defined(_WIN32)
  // Fused synchronous DirectML keyer: key the CURRENT frame every program frame
  // (mask age 0 -> the mask body tracks motion, no edge lag). Default ON -- the
  // Windows production keyer, matching the macOS fused path. Kill-switch:
  // BROADIFY_MEETING_GPU_PIPELINE=0 falls back to the async MODNet worker (older
  // mask, edge lag on motion). The worker self-parks when ON (submit guard
  // below). NOTE: fused locks program fps to inference fps; on a very weak GPU
  // the async path (=0) can be smoother.
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_GPU_PIPELINE");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
#else
  return false;
#endif
}

#if defined(_WIN32)
// Auto-degradation governor kill-switch (default ON). Set
// BROADIFY_MEETING_AUTO_DEGRADE=0 to keep the pre-governor behavior: the fused
// input resolution follows the webapp performance mode and the fused path
// never self-demotes to async/off. Read once, like gpuPipelineEnabled.
bool autoDegradeEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_AUTO_DEGRADE");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
}

// Warm handover on governor tier transitions (default ON). Make-before-break
// between the fused synchronous keyer and the async worker: a step-up warms
// the fused DirectML session on a background thread before the cutover, and a
// step-down keeps the fused keyer on air until the worker publishes its first
// pair. Motivation: the DirectML session build for a new shape costs 0.25s on
// an idle dGPU and up to ~12s on an iGPU under load — with immediate cutover
// that was seconds of un-keyed program output on every tier transition.
// Kill-switch: BROADIFY_MEETING_WARM_HANDOVER=0 restores the immediate
// cutover. Read once, like gpuPipelineEnabled.
bool warmHandoverEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_WARM_HANDOVER");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
}

// Fused-path postprocess parity (default ON): run the same user-facing mask
// postprocess chain the async worker applies (morphological close ->
// smoothstep remap -> edge stabilization -> erode/dilate -> feather), so
// mask_erode_px / mask_dilate_px / mask_feather_px / dynamic_dilation /
// edge_stabilization_* stop being silently ignored on the fused path (they
// were only ever applied inside the worker's postprocessAlpha call - the
// cause of the flickery coarse edges at fused@256). Kill-switch:
// BROADIFY_MEETING_FUSED_POSTPROCESS=0 restores the previous fused output.
// Read once, like gpuPipelineEnabled.
bool fusedPostprocessEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_FUSED_POSTPROCESS");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
}

bool fusedSmootherEmaEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_FUSED_SMOOTHER");
    return raw == nullptr || raw[0] == '\0' || std::string(raw) != "edge";
  }();
  return enabled;
}

// fused and fused_cadence are the SAME active path for transition-reset
// purposes (the cadence merely skips inferences within the fused path).
std::string canonicalKeyerPathLabel(const std::string &label) {
  return label == "fused_cadence" ? std::string("fused") : label;
}

// BROADIFY_MEETING_KEYER_CADENCE: unset/"auto" -> auto-derive the fused
// inference interval N from the smoothed inference cost; "0" -> cadence inert
// (infer every frame); integer N >= 1 -> pin N (1 = every frame).
struct FusedCadenceEnv {
  bool enabled = true;
  int pinnedN = 0;
};

FusedCadenceEnv fusedCadenceEnv() {
  static const FusedCadenceEnv parsed = [] {
    FusedCadenceEnv env;
    const char *raw = std::getenv("BROADIFY_MEETING_KEYER_CADENCE");
    if (raw == nullptr || raw[0] == '\0' || std::string(raw) == "auto") {
      return env;
    }
    const int value = std::atoi(raw);
    if (value <= 0) {
      env.enabled = false;
      return env;
    }
    env.pinnedN = std::min(value, 30);
    return env;
  }();
  return parsed;
}

// BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS: testing override for the governor's
// step-down threshold (replaces stepDownFactor * frame budget when > 0).
double keyerMaxInferenceOverrideMs() {
  static const double value = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS");
    return raw != nullptr ? std::atof(raw) : 0.0;
  }();
  return value;
}

// Same validation as readKeyerPerformanceOverride in keyer_chain.cpp: when the
// resolution is pinned via env for A/B testing, the governor must not fight it
// (it keeps sampling, but stops driving performanceMode).
bool fusedKeyerPerformanceOverrideActive() {
  static const bool active = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_KEYER_PERFORMANCE");
    if (raw == nullptr) {
      return false;
    }
    const std::string v(raw);
    return v == "high_quality" || v == "balanced" || v == "performance";
  }();
  return active;
}

bool fusedPipelineDepthEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_FUSED_PIPELINE_DEPTH");
    return raw == nullptr || raw[0] != '0';
  }();
  return enabled;
}

KeyerGovernorConfig makeFusedGovernorConfig(uint32_t fps) {
  KeyerGovernorConfig config;
  config.frameBudgetMs = 1000.0 / static_cast<double>(fps == 0u ? 30u : fps);
  config.stepDownOverrideMs = keyerMaxInferenceOverrideMs();
  // Warm handover: defer the Lite256 -> Performance256 step-up until the
  // background session warmup succeeded (make-before-break). With the
  // kill-switch off this stays the historical immediate step-up.
  config.deferLiteStepUp = warmHandoverEnabled();
  return config;
}

FusedCadenceConfig makeFusedCadenceConfig(uint32_t fps) {
  FusedCadenceConfig config;
  config.frameBudgetMs = 1000.0 / static_cast<double>(fps == 0u ? 30u : fps);
  const FusedCadenceEnv env = fusedCadenceEnv();
  config.enabled = env.enabled;
  config.pinnedN = env.pinnedN;
  return config;
}
#endif  // _WIN32

// Edge-live mode (default OFF = the proven path). When ON, MODNet's edge cleanup
// moves OUT of the keyer worker (where the joint-bilateral refine ages the mask)
// INTO the program loop's live-frame snap: the mask publishes fresher (less
// latency) and the edge is aligned+sharpened against the CURRENT frame (better on
// motion). Opt in with BROADIFY_MEETING_EDGE_LIVE=1 to A/B without ever leaving
// the known-good default.
bool edgeLiveEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_EDGE_LIVE");
    return raw != nullptr && raw[0] == '1';
  }();
  return enabled;
}

bool asyncPreTemporalBlendEnabled() {
#if defined(_WIN32)
  return false;
#else
  return true;
#endif
}

// Half-width of the alpha band (around 0.5) that gets stretched to a crisp
// transition by sharpenAlphaEdge. Smaller = harder edge. Overridable for tuning.
double edgeSharpenHalfWidth() {
  static const double w = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_EDGE_SHARPEN");
    if (raw == nullptr || raw[0] == '\0') return 0.30;
    const double v = std::atof(raw);
    return (v > 0.02 && v <= 0.5) ? v : 0.30;
  }();
  return w;
}

// Tighten the soft edge the guided filter leaves: stretch the mid-alpha band
// around 0.5 into a crisp smoothstep transition. This kills the background bleed
// of a purely-aligned soft edge without moving the boundary the snap locked onto
// the live frame.
void sharpenAlphaEdge(AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return;
  }
  const float halfWidth = static_cast<float>(edgeSharpenHalfWidth());
  const float invSpan = 1.0f / (2.0f * halfWidth);
  for (uint8_t &alpha : mask.alpha) {
    const float centered = (static_cast<float>(alpha) / 255.0f - 0.5f) * invSpan + 0.5f;
    const float t = std::clamp(centered, 0.0f, 1.0f);
    alpha = static_cast<uint8_t>(t * t * (3.0f - 2.0f * t) * 255.0f + 0.5f);
  }
}

struct PairedKeyerFrame {
  VideoFrame frame;
  AlphaMask mask;
  uint64_t publishedAtNs = 0u;
  // Inference cost of the pass that produced this mask, captured at publish
  // time under the worker mutex. Governor samples read THIS instead of the
  // shared state.inferenceMs, which is written after the pair is published
  // and can still hold a stale pre-demotion value for the first sample.
  // <= 0 means unknown (no sample is fed).
  double inferenceMs = -1.0;
};

struct KeyerRuntimeStats {
  double keyerFps = -1.0;
  double droppedFramesPerSec = -1.0;
  uint64_t droppedFramesTotal = 0;
  uint64_t skippedFramesTotal = 0;
};

struct PipelineRuntimeState {
  bool cameraRunning = false;
  bool keyerEnabled = false;
  bool framebusRunning = false;
  int previewClients = 0;
  int vcamClients = 0;
  bool programDirty = false;
  bool graphicsDirty = false;
  uint64_t programRevision = 0;
  int pipCameraIndex = -1;
  bool autoDirectorEnabled = false;
  float autoDirectorThreshold = 0.02f;
  std::string mode = "idle";
};

bool hasActiveOutputConsumer(const PipelineRuntimeState &runtime) {
  return runtime.framebusRunning || runtime.previewClients > 0 || runtime.vcamClients > 0;
}

bool isGraphicsOutputActive(const CompositorSnapshot &snapshot) {
  return snapshot.graphics.enabled ||
      !snapshot.graphics.graphicId.empty() ||
      !snapshot.graphics.templateName.empty() ||
      !snapshot.graphics.source.empty();
}

std::string determinePipelineMode(const PipelineRuntimeState &runtime,
                                  const CompositorSnapshot &snapshot) {
  if (runtime.cameraRunning) {
    return runtime.keyerEnabled ? "keyer_live" : "live";
  }
  if (isGraphicsOutputActive(snapshot)) {
    return "live";
  }
  if (hasActiveOutputConsumer(runtime)) {
    return "static_output";
  }
  return "idle";
}

class RateMeter {
 public:
  void tick(const std::chrono::steady_clock::time_point now) {
    if (windowStart_ == std::chrono::steady_clock::time_point{}) {
      windowStart_ = now;
    }
    ++currentCount_;
    update(now);
  }

  double value(const std::chrono::steady_clock::time_point now) {
    update(now);
    return currentValue_;
  }

 private:
  void update(const std::chrono::steady_clock::time_point now) {
    if (windowStart_ == std::chrono::steady_clock::time_point{}) {
      return;
    }
    const double elapsedMs = std::chrono::duration<double, std::milli>(now - windowStart_).count();
    if (elapsedMs < kMetricsWindowMs) {
      return;
    }
    currentValue_ = static_cast<double>(currentCount_) * 1000.0 / std::max(1.0, elapsedMs);
    currentCount_ = 0u;
    windowStart_ = now;
  }

  std::chrono::steady_clock::time_point windowStart_{};
  uint64_t currentCount_ = 0u;
  double currentValue_ = -1.0;
};

class RollingAverage {
 public:
  void add(double value) {
    if (value < 0.0) {
      return;
    }
    samples_.push_back(value);
    sum_ += value;
    while (samples_.size() > kMaskAgeWindowSize) {
      sum_ -= samples_.front();
      samples_.pop_front();
    }
  }

  double value() const {
    if (samples_.empty()) {
      return -1.0;
    }
    return sum_ / static_cast<double>(samples_.size());
  }

  void clear() {
    samples_.clear();
    sum_ = 0.0;
  }

 private:
  std::deque<double> samples_;
  double sum_ = 0.0;
};

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

float clamp01(float value) {
  return std::clamp(value, 0.0f, 1.0f);
}

float lerp(float start, float end, float amount) {
  return start + (end - start) * amount;
}

float smoothstep(float edge0, float edge1, float value) {
  const float t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3.0f - 2.0f * t);
}

const std::array<uint8_t, 256> &smoothstepAlphaLut() {
  static const std::array<uint8_t, 256> lut = [] {
    std::array<uint8_t, 256> table{};
    for (size_t index = 0; index < table.size(); ++index) {
      const float normalizedAlpha = static_cast<float>(index) / 255.0f;
      table[index] =
          static_cast<uint8_t>(std::round(smoothstep(kSmoothstepLow, kSmoothstepHigh, normalizedAlpha) * 255.0f));
    }
    return table;
  }();
  return lut;
}

void remapAlphaSmoothstep(AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return;
  }

  const std::array<uint8_t, 256> &lut = smoothstepAlphaLut();
  for (uint8_t &alpha : mask.alpha) {
    alpha = lut[alpha];
  }
}

constexpr int kMaskRefineTapCount = 2 * kMaskRefineRadiusPx + 1;

const std::array<uint16_t, 256> &maskRefineRangeLut() {
  static const std::array<uint16_t, 256> lut = [] {
    std::array<uint16_t, 256> table{};
    for (size_t diff = 0; diff < table.size(); ++diff) {
      const float weight = std::exp(
          -static_cast<float>(diff * diff) /
          (2.0f * kMaskRefineRangeSigmaLuma * kMaskRefineRangeSigmaLuma));
      table[diff] = static_cast<uint16_t>(std::round(weight * 64.0f));
    }
    return table;
  }();
  return lut;
}

// Spatial weights per output-pixel parity: with 2x upsampling, even/odd output
// pixels sit a quarter source pixel left/right (up/down) of their base tap.
const std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> &maskRefineSpatialLut() {
  static const std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> lut = [] {
    std::array<std::array<uint16_t, kMaskRefineTapCount>, 2> table{};
    for (int parity = 0; parity < 2; ++parity) {
      const float offset = parity == 0 ? -0.25f : 0.25f;
      for (int tap = 0; tap < kMaskRefineTapCount; ++tap) {
        const float distance = static_cast<float>(tap - kMaskRefineRadiusPx) - offset;
        const float weight = std::exp(
            -(distance * distance) /
            (2.0f * kMaskRefineSpatialSigmaPx * kMaskRefineSpatialSigmaPx));
        table[parity][tap] = static_cast<uint16_t>(std::round(weight * 64.0f));
      }
    }
    return table;
  }();
  return lut;
}

// Edge-guided smoothing at mask resolution for mid-size masks (Vision
// "balanced"): same joint-bilateral kernel as the 2x upsampling path, but
// without scaling - the mask snaps to real image contours and flickers less.
void smoothAlphaMaskEdgesGuided(AlphaMask &mask, const VideoFrame &frame) {
  const uint32_t width = mask.width;
  const uint32_t height = mask.height;
  std::vector<uint8_t> luma(static_cast<size_t>(width) * height);
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t frameY = std::min<uint32_t>(
        frame.height - 1u,
        static_cast<uint32_t>(((2ull * y + 1ull) * frame.height) / (2ull * height)));
    const size_t frameRowOffset = static_cast<size_t>(frameY) * frame.width;
    const size_t lumaRowOffset = static_cast<size_t>(y) * width;
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t frameX = std::min<uint32_t>(
          frame.width - 1u,
          static_cast<uint32_t>(((2ull * x + 1ull) * frame.width) / (2ull * width)));
      const size_t pixelOffset = (frameRowOffset + frameX) * 4u;
      luma[lumaRowOffset + x] = static_cast<uint8_t>(
          (77u * frame.rgba[pixelOffset] +
           150u * frame.rgba[pixelOffset + 1u] +
           29u * frame.rgba[pixelOffset + 2u]) >> 8u);
    }
  }

  static const uint16_t kCenteredSpatial[kMaskRefineTapCount] = {9, 39, 64, 39, 9};
  const std::array<uint16_t, 256> &rangeLut = maskRefineRangeLut();
  std::vector<uint8_t> smoothed(mask.alpha.size());
  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t *guideRow = luma.data() + static_cast<size_t>(y) * width;
    uint8_t *outputRow = smoothed.data() + static_cast<size_t>(y) * width;
    for (uint32_t x = 0; x < width; ++x) {
      const uint8_t guide = guideRow[x];
      uint32_t weightedAlpha = 0u;
      uint32_t weightSum = 0u;
      for (int tapY = 0; tapY < kMaskRefineTapCount; ++tapY) {
        const int sampleY = std::clamp(static_cast<int>(y) + tapY - kMaskRefineRadiusPx, 0, static_cast<int>(height) - 1);
        const size_t rowOffset = static_cast<size_t>(sampleY) * width;
        const uint32_t wy = kCenteredSpatial[tapY];
        for (int tapX = 0; tapX < kMaskRefineTapCount; ++tapX) {
          const int sampleX = std::clamp(static_cast<int>(x) + tapX - kMaskRefineRadiusPx, 0, static_cast<int>(width) - 1);
          const size_t sampleOffset = rowOffset + static_cast<size_t>(sampleX);
          const uint32_t lumaDiff = static_cast<uint32_t>(
              std::abs(static_cast<int>(luma[sampleOffset]) - static_cast<int>(guide)));
          const uint32_t weight = wy * kCenteredSpatial[tapX] * rangeLut[lumaDiff];
          weightedAlpha += weight * mask.alpha[sampleOffset];
          weightSum += weight;
        }
      }
      outputRow[x] = weightSum > 0u
          ? static_cast<uint8_t>((weightedAlpha + weightSum / 2u) / weightSum)
          : mask.alpha[static_cast<size_t>(y) * width + x];
    }
  }
  mask.alpha = std::move(smoothed);
}

// The 2x joint-bilateral upsample quadruples the pixel count of every
// downstream postprocess pass (close/erode/feather/temporal). The compositor
// samples the mask bilinearly at any resolution, so by default small masks
// keep their native size and get the edge-guided smoothing instead. Opt back
// into the old upscale path with BROADIFY_MEETING_MASK_UPSCALE_2X=1.
bool maskUpscale2xEnabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("BROADIFY_MEETING_MASK_UPSCALE_2X");
    return raw != nullptr && raw[0] == '1';
  }();
  return enabled;
}

// Joint bilateral 2x upsampling: coarse masks (e.g. Vision "fast", 256x192)
// are refined along the luminance edges of the camera frame before
// postprocessing, so cheap masks produce smooth, image-aligned edges instead
// of the blocky gradients a plain bilinear upscale would give.
void refineAlphaMaskEdges(AlphaMask &mask, const VideoFrame &frame) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u ||
      frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return;
  }
  if (mask.width >= kMaskRefineMaxSourceWidthPx) {
    // Mid-size (balanced) masks: edge-guided smoothing without upscaling.
    if (mask.width < 640u) {
      smoothAlphaMaskEdgesGuided(mask, frame);
    }
    return;
  }
  if (!maskUpscale2xEnabled()) {
    smoothAlphaMaskEdgesGuided(mask, frame);
    return;
  }

  const uint32_t refinedWidth = mask.width * 2u;
  const uint32_t refinedHeight = mask.height * 2u;

  // Guide luma at refined resolution; the mask spans the full frame, so
  // sample the camera frame at matching normalized positions.
  std::vector<uint8_t> lumaHigh(static_cast<size_t>(refinedWidth) * refinedHeight);
  for (uint32_t y = 0; y < refinedHeight; ++y) {
    const uint32_t frameY = std::min<uint32_t>(
        frame.height - 1u,
        static_cast<uint32_t>(((2ull * y + 1ull) * frame.height) / (2ull * refinedHeight)));
    const size_t frameRowOffset = static_cast<size_t>(frameY) * frame.width;
    const size_t lumaRowOffset = static_cast<size_t>(y) * refinedWidth;
    for (uint32_t x = 0; x < refinedWidth; ++x) {
      const uint32_t frameX = std::min<uint32_t>(
          frame.width - 1u,
          static_cast<uint32_t>(((2ull * x + 1ull) * frame.width) / (2ull * refinedWidth)));
      const size_t pixelOffset = (frameRowOffset + frameX) * 4u;
      lumaHigh[lumaRowOffset + x] = static_cast<uint8_t>(
          (77u * frame.rgba[pixelOffset] +
           150u * frame.rgba[pixelOffset + 1u] +
           29u * frame.rgba[pixelOffset + 2u]) >> 8u);
    }
  }

  // Guide luma at mask resolution (2x2 box of the refined guide).
  std::vector<uint8_t> lumaLow(static_cast<size_t>(mask.width) * mask.height);
  for (uint32_t y = 0; y < mask.height; ++y) {
    const size_t rowTop = static_cast<size_t>(y) * 2u * refinedWidth;
    const size_t rowBottom = rowTop + refinedWidth;
    for (uint32_t x = 0; x < mask.width; ++x) {
      const size_t left = static_cast<size_t>(x) * 2u;
      const uint32_t sum =
          static_cast<uint32_t>(lumaHigh[rowTop + left]) + lumaHigh[rowTop + left + 1u] +
          lumaHigh[rowBottom + left] + lumaHigh[rowBottom + left + 1u];
      lumaLow[static_cast<size_t>(y) * mask.width + x] = static_cast<uint8_t>(sum / 4u);
    }
  }

  const std::array<uint16_t, 256> &rangeLut = maskRefineRangeLut();
  const auto &spatialLut = maskRefineSpatialLut();
  std::vector<uint8_t> refinedAlpha(lumaHigh.size());
  for (uint32_t oy = 0; oy < refinedHeight; ++oy) {
    const int baseY = static_cast<int>(oy >> 1u);
    const std::array<uint16_t, kMaskRefineTapCount> &spatialY = spatialLut[oy & 1u];
    const uint8_t *guideRow = lumaHigh.data() + static_cast<size_t>(oy) * refinedWidth;
    uint8_t *outputRow = refinedAlpha.data() + static_cast<size_t>(oy) * refinedWidth;
    for (uint32_t ox = 0; ox < refinedWidth; ++ox) {
      const int baseX = static_cast<int>(ox >> 1u);
      const std::array<uint16_t, kMaskRefineTapCount> &spatialX = spatialLut[ox & 1u];
      const uint8_t guideLuma = guideRow[ox];
      uint32_t weightedAlpha = 0u;
      uint32_t weightSum = 0u;
      for (int tapY = 0; tapY < kMaskRefineTapCount; ++tapY) {
        const int sampleY = std::clamp(baseY + tapY - kMaskRefineRadiusPx, 0, static_cast<int>(mask.height) - 1);
        const size_t sampleRowOffset = static_cast<size_t>(sampleY) * mask.width;
        const uint32_t spatialWeightY = spatialY[tapY];
        for (int tapX = 0; tapX < kMaskRefineTapCount; ++tapX) {
          const int sampleX = std::clamp(baseX + tapX - kMaskRefineRadiusPx, 0, static_cast<int>(mask.width) - 1);
          const size_t sampleOffset = sampleRowOffset + static_cast<size_t>(sampleX);
          const uint32_t lumaDiff = static_cast<uint32_t>(
              std::abs(static_cast<int>(lumaLow[sampleOffset]) - static_cast<int>(guideLuma)));
          const uint32_t weight = spatialWeightY * spatialX[tapX] * rangeLut[lumaDiff];
          weightedAlpha += weight * mask.alpha[sampleOffset];
          weightSum += weight;
        }
      }
      outputRow[ox] = weightSum > 0u
          ? static_cast<uint8_t>((weightedAlpha + weightSum / 2u) / weightSum)
          : mask.alpha[static_cast<size_t>(baseY) * mask.width + static_cast<size_t>(baseX)];
    }
  }

  mask.width = refinedWidth;
  mask.height = refinedHeight;
  mask.alpha = std::move(refinedAlpha);
}

struct WedgeEntry {
  size_t index = 0u;
  uint8_t value = 0u;
};

// Sliding-window extremum (monotonic wedge): for every position the min or
// max over the clamped window [i - radius, i + radius] in amortized O(1) per
// pixel, independent of the radius. Results match a brute-force clamped
// window scan exactly.
void slidingExtremaLine(const uint8_t *source,
                        uint8_t *destination,
                        size_t count,
                        size_t stride,
                        size_t radius,
                        bool takeMax,
                        std::vector<WedgeEntry> &wedge) {
  if (count == 0u) {
    return;
  }

  wedge.clear();
  size_t head = 0u;
  size_t next = 0u;
  const auto push = [&](size_t index) {
    const uint8_t candidate = source[index * stride];
    while (wedge.size() > head &&
           (takeMax ? wedge.back().value <= candidate : wedge.back().value >= candidate)) {
      wedge.pop_back();
    }
    wedge.push_back(WedgeEntry{index, candidate});
  };

  for (size_t index = 0; index < count; ++index) {
    const size_t upper = std::min(count - 1u, index + radius);
    while (next <= upper) {
      push(next);
      ++next;
    }
    const size_t lower = index > radius ? index - radius : 0u;
    while (wedge[head].index < lower) {
      ++head;
    }
    destination[index * stride] = wedge[head].value;
  }
}

void slidingExtrema2d(const std::vector<uint8_t> &source,
                      std::vector<uint8_t> &destination,
                      uint32_t width,
                      uint32_t height,
                      uint32_t radius,
                      bool takeMax) {
  std::vector<uint8_t> horizontal(source.size());
  std::vector<WedgeEntry> wedge;
  wedge.reserve(static_cast<size_t>(radius) * 2u + 2u);
  for (uint32_t y = 0; y < height; ++y) {
    const size_t rowOffset = static_cast<size_t>(y) * width;
    slidingExtremaLine(source.data() + rowOffset, horizontal.data() + rowOffset, width, 1u, radius, takeMax, wedge);
  }
  destination.resize(source.size());
  for (uint32_t x = 0; x < width; ++x) {
    slidingExtremaLine(horizontal.data() + x, destination.data() + x, height, width, radius, takeMax, wedge);
  }
}

void dilateAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  std::vector<uint8_t> dilatedAlpha;
  slidingExtrema2d(mask.alpha, dilatedAlpha, mask.width, mask.height, radius, true);
  mask.alpha = std::move(dilatedAlpha);
}

std::vector<uint8_t> erodedAlphaForRadius(const AlphaMask &mask, uint32_t radius) {
  std::vector<uint8_t> erodedAlpha;
  slidingExtrema2d(mask.alpha, erodedAlpha, mask.width, mask.height, radius, false);
  return erodedAlpha;
}

void erodeAlpha(AlphaMask &mask, double radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius <= 0.0) {
    return;
  }

  const double clampedRadius = std::clamp(radius, 0.0, 3.0);
  const uint32_t lowerRadius = static_cast<uint32_t>(std::floor(clampedRadius));
  const uint32_t upperRadius = static_cast<uint32_t>(std::ceil(clampedRadius));
  const double upperWeight = clampedRadius - static_cast<double>(lowerRadius);

  if (upperRadius == 0u) {
    return;
  }

  const std::vector<uint8_t> originalAlpha = mask.alpha;
  std::vector<uint8_t> lowerAlpha = lowerRadius == 0u ? originalAlpha : erodedAlphaForRadius(mask, lowerRadius);
  if (upperWeight <= 0.0 || lowerRadius == upperRadius) {
    mask.alpha = std::move(lowerAlpha);
    return;
  }

  const std::vector<uint8_t> upperAlpha = erodedAlphaForRadius(mask, upperRadius);
  const double lowerWeight = 1.0 - upperWeight;
  for (size_t index = 0; index < mask.alpha.size(); ++index) {
    const double blendedAlpha =
        static_cast<double>(lowerAlpha[index]) * lowerWeight + static_cast<double>(upperAlpha[index]) * upperWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0, 255.0)));
  }
}

// Running-sum box average over the clamped window [i - radius, i + radius];
// same integer arithmetic as a brute-force window scan, but O(1) per pixel.
void slidingBoxAverageLine(const uint8_t *source,
                           uint8_t *destination,
                           size_t count,
                           size_t stride,
                           size_t radius) {
  if (count == 0u) {
    return;
  }

  uint32_t sumAlpha = 0u;
  uint32_t sampleCount = 0u;
  const size_t initialUpper = std::min(count - 1u, radius);
  for (size_t index = 0; index <= initialUpper; ++index) {
    sumAlpha += source[index * stride];
    ++sampleCount;
  }

  for (size_t index = 0; index < count; ++index) {
    destination[index * stride] = static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    const size_t incoming = index + radius + 1u;
    if (incoming < count) {
      sumAlpha += source[incoming * stride];
      ++sampleCount;
    }
    if (index >= radius) {
      sumAlpha -= source[(index - radius) * stride];
      --sampleCount;
    }
  }
}

void featherAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> featheredAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    const size_t rowOffset = static_cast<size_t>(y) * mask.width;
    slidingBoxAverageLine(mask.alpha.data() + rowOffset, horizontalAlpha.data() + rowOffset, mask.width, 1u, radius);
  }
  for (uint32_t x = 0; x < mask.width; ++x) {
    slidingBoxAverageLine(horizontalAlpha.data() + x, featheredAlpha.data() + x, mask.height, mask.width, radius);
  }

  mask.alpha = std::move(featheredAlpha);
}

std::vector<uint8_t> alphaProtectionMask(const AlphaMask &mask, uint32_t radius) {
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> sourceMask(pixelCount);
  for (size_t index = 0; index < pixelCount; ++index) {
    sourceMask[index] = mask.alpha[index] >= kTemporalProtectionAlphaThreshold ? 1u : 0u;
  }

  std::vector<uint8_t> protectionMask;
  slidingExtrema2d(sourceMask, protectionMask, mask.width, mask.height, radius, true);
  return protectionMask;
}

void blendAlphaTemporal(AlphaMask &mask, const AlphaMask &previousMask, double maskAgeMs) {
  if (mask.alpha.empty() ||
      previousMask.alpha.empty() ||
      mask.width == 0u ||
      mask.height == 0u ||
      mask.width != previousMask.width ||
      mask.height != previousMask.height ||
      mask.timestampNs <= previousMask.timestampNs ||
      mask.timestampNs - previousMask.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const std::vector<uint8_t> protectionMask = alphaProtectionMask(mask, kTemporalProtectionRadiusPx);
  const float maxPreviousWeight = maskAgeMs >= kStaleMaskAgeMs ? kStalePreviousWeight : kQuietPreviousWeight;
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const uint8_t currentAlpha = mask.alpha[index];
    const uint8_t previousAlpha = previousMask.alpha[index];
    if (protectionMask[index] == 0u) {
      continue;
    }
    const float motion = static_cast<float>(std::abs(static_cast<int>(currentAlpha) - static_cast<int>(previousAlpha))) / 255.0f;
    const float previousWeight = lerp(maxPreviousWeight, kMotionPreviousWeight, motion);
    const float currentWeight = 1.0f - previousWeight;
    const float blendedAlpha =
        static_cast<float>(currentAlpha) * currentWeight +
        static_cast<float>(previousAlpha) * previousWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0f, 255.0f)));
  }
}

void stabilizeAlphaEdges(AlphaMask &mask, const AlphaMask &previousMask, const KeyerSettings &settings, double maskAgeMs) {
  if (!settings.edgeStabilizationEnabled ||
      settings.edgeStabilizationStrength <= 0.0 ||
      mask.alpha.empty() ||
      previousMask.alpha.empty() ||
      mask.width == 0u ||
      mask.height == 0u ||
      mask.width != previousMask.width ||
      mask.height != previousMask.height ||
      mask.timestampNs <= previousMask.timestampNs ||
      mask.timestampNs - previousMask.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const std::array<uint8_t, 256> &lut = smoothstepAlphaLut();
  const float strength = static_cast<float>(std::clamp(settings.edgeStabilizationStrength, 0.0, 1.0));
  float ageFactor = 1.0f;
  if (maskAgeMs >= kEdgeStabilizationFadeOutAgeMs) {
    ageFactor = kEdgeStabilizationMinAgeFactor;
  } else if (maskAgeMs > kEdgeStabilizationFreshAgeMs) {
    const double fadeProgress =
        (maskAgeMs - kEdgeStabilizationFreshAgeMs) /
        (kEdgeStabilizationFadeOutAgeMs - kEdgeStabilizationFreshAgeMs);
    ageFactor = lerp(1.0f, kEdgeStabilizationMinAgeFactor, static_cast<float>(fadeProgress));
  }
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const uint8_t currentAlpha = mask.alpha[index];
    if (currentAlpha <= kEdgeStabilizationAlphaLow || currentAlpha >= kEdgeStabilizationAlphaHigh) {
      continue;
    }

    const uint8_t previousAlpha = lut[previousMask.alpha[index]];
    const float motion = static_cast<float>(std::abs(static_cast<int>(currentAlpha) - static_cast<int>(previousAlpha))) / 255.0f;
    if (motion >= kEdgeStabilizationMaxMotion) {
      continue;
    }

    const float normalizedAlpha = static_cast<float>(currentAlpha) / 255.0f;
    const float edgeFactor = 1.0f - std::abs((normalizedAlpha - 0.5f) * 2.0f);
    const float motionFactor = 1.0f - (motion / kEdgeStabilizationMaxMotion);
    const float previousWeight = std::clamp(strength * edgeFactor * motionFactor * ageFactor, 0.0f, 0.65f);
    const float currentWeight = 1.0f - previousWeight;
    const float blendedAlpha =
        static_cast<float>(currentAlpha) * currentWeight + static_cast<float>(previousAlpha) * previousWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0f, 255.0f)));
  }
}

uint32_t dynamicDilationRadius(const KeyerSettings &settings, double maskAgeMs) {
  uint32_t radius = std::min(settings.maskDilatePx, kMaxAlphaDilateRadiusPx);
  if (radius == 0u || !settings.dynamicDilation || maskAgeMs < 0.0) {
    return radius;
  }
  if (maskAgeMs >= 200.0) {
    radius += 4u;
  } else if (maskAgeMs >= 132.0) {
    radius += 3u;
  } else if (maskAgeMs >= 66.0) {
    radius += 2u;
  }
  return std::min(radius, kMaxAlphaDilateRadiusPx);
}

void postprocessAlpha(AlphaMask &mask,
                      const AlphaMask &previousMask,
                      const KeyerSettings &settings,
                      double maskAgeMs,
                      KeyerMetrics &metrics) {
  const auto start = std::chrono::steady_clock::now();
  // Morphological close first: fill small holes the segmenter left inside the
  // foreground before smoothing/eroding shape the edge.
  if (kMaskCloseRadiusPx > 0u) {
    dilateAlpha(mask, kMaskCloseRadiusPx);
    erodeAlpha(mask, static_cast<double>(kMaskCloseRadiusPx));
  }
  const auto closeEnd = std::chrono::steady_clock::now();
  remapAlphaSmoothstep(mask);
  const auto remapEnd = std::chrono::steady_clock::now();
  KeyerSettings effectiveSettings = settings;
#if defined(_WIN32)
  if (fusedSmootherEmaEnabled() && maskAgeMs == 0.0) {
    effectiveSettings.edgeStabilizationEnabled = false;
  }
#endif
  stabilizeAlphaEdges(mask, previousMask, effectiveSettings, maskAgeMs);
  const auto dilateStart = std::chrono::steady_clock::now();
  erodeAlpha(mask, settings.maskErodePx);
  dilateAlpha(mask, dynamicDilationRadius(settings, maskAgeMs));
  const auto dilateEnd = std::chrono::steady_clock::now();
  featherAlpha(mask, std::min(settings.maskFeatherPx, kMaxAlphaFeatherRadiusPx));
  const auto end = std::chrono::steady_clock::now();
  metrics.maskCloseMs = elapsedMs(start, closeEnd);
  metrics.maskRemapMs = elapsedMs(closeEnd, remapEnd);
  metrics.maskStabilizeMs = elapsedMs(remapEnd, dilateStart);
  metrics.maskDilateMs = elapsedMs(dilateStart, dilateEnd);
  metrics.maskFeatherMs = elapsedMs(dilateEnd, end);
  metrics.maskPostprocessMs = elapsedMs(start, end);
}

class AsyncKeyerWorker {
 public:
  AsyncKeyerWorker(const Options &options, MeetingState &state, std::atomic<bool> &running)
      : keyerChain_(options),
        state_(state),
        running_(running),
        frameIntervalMs_(1000.0 / static_cast<double>(options.fps == 0u ? 30u : options.fps)),
        thread_(&AsyncKeyerWorker::run, this) {}

  ~AsyncKeyerWorker() {
    stop();
  }

  // Adaptive pacing: every new camera frame is offered to the worker; while
  // the worker is busy the pending slot is replaced (counted as dropped) so
  // inference always runs back-to-back on the freshest frame. The effective
  // keyer rate is min(camera fps, 1 / inference time) without a fixed cap.
  void submit(const VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (hasPendingFrame_) {
      ++droppedFrames_;
    }
    pendingFrame_ = frame;
    pendingGeneration_ = generation_;
    hasPendingFrame_ = true;
    cv_.notify_one();
  }

  // Returns the latest published pair without copying frame data; callers
  // share ownership of the immutable pair.
  std::shared_ptr<const PairedKeyerFrame> copyLatest() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return latestPair_;
  }

  // Governor floor pass-through (Windows async-lite): see KeyerChain.
  void setGovernorPerformanceFloor(bool active) {
    keyerChain_.setGovernorPerformanceFloor(active);
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++generation_;
    hasPendingFrame_ = false;
    latestPair_.reset();
    lastPublishedCoverage_ = 0.0;
    presenceTracker_.reset();
    droppedFrames_ = 0;
    skippedFrames_ = 0;
    keyerRate_ = RateMeter{};
    lastDropRateSample_ = std::chrono::steady_clock::now();
    lastDropRateTotal_ = 0u;
    droppedFramesPerSec_ = -1.0;
  }

  uint64_t droppedFrames() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedFrames_;
  }

  KeyerRuntimeStats stats() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = std::chrono::steady_clock::now();
    updateDropRateLocked(now);
    return KeyerRuntimeStats{keyerRate_.value(now), droppedFramesPerSec_, droppedFrames_, skippedFrames_};
  }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
      hasPendingFrame_ = false;
    }
    cv_.notify_one();
    if (thread_.joinable()) {
      thread_.join();
    }
  }

 private:
  void run() {
    while (running_.load()) {
      VideoFrame frame;
      uint64_t generation = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [&]() {
          return stopping_ || !running_.load() || hasPendingFrame_;
        });
        if (stopping_ || !running_.load()) {
          return;
        }
        frame = std::move(pendingFrame_);
        generation = pendingGeneration_;
        hasPendingFrame_ = false;
      }

      const uint64_t keyerStartNs = nowNs();
      KeyerResult keyed = keyerChain_.process(frame, state_);
      // Measure coverage on the RAW mask, before postprocessing can zero out a
      // faint mask — this is what the collapse guard judges.
      const double rawCoverage = computeMaskCoverage(keyed.mask);
      const auto refineStart = std::chrono::steady_clock::now();
      // Edge-live mode moves MODNet's edge cleanup to the program loop's
      // live-frame snap, so skip the mask-ageing worker-side refine here.
      if (!(edgeLiveEnabled() && keyed.status.backend == "modnet")) {
        refineAlphaMaskEdges(keyed.mask, frame);
      }
      const double refineMs = elapsedMs(refineStart, std::chrono::steady_clock::now());
      AlphaMask previousMask;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (latestPair_ != nullptr) {
          previousMask = latestPair_->mask;
        }
      }
      KeyerSettings settings;
      double maskAgeMs = -1.0;
      {
        std::lock_guard<std::mutex> stateLock(state_.mutex);
        settings.qualityMode = state_.qualityMode;
        settings.maskErodePx = state_.maskErodePx;
        settings.maskDilatePx = state_.maskDilatePx;
        settings.maskFeatherPx = state_.maskFeatherPx;
        settings.dynamicDilation = state_.dynamicDilation;
        settings.temporalBlendEnabled = state_.temporalBlendEnabled;
        settings.edgeStabilizationEnabled = state_.edgeStabilizationEnabled;
        settings.edgeStabilizationStrength = state_.edgeStabilizationStrength;
        settings.degradation = state_.degradationSettings;
        maskAgeMs = state_.keyerMetrics.maskAgeMs;
      }
      const auto temporalStart = std::chrono::steady_clock::now();
      if (settings.temporalBlendEnabled && asyncPreTemporalBlendEnabled()) {
        blendAlphaTemporal(keyed.mask, previousMask, maskAgeMs);
      }
      const double temporalPreMs =
          elapsedMs(temporalStart, std::chrono::steady_clock::now());
      postprocessAlpha(keyed.mask, previousMask, settings, maskAgeMs, keyed.status.metrics);
      // Full-frame temporal EMA against the last published mask — the core
      // anti-flicker stabilizer. Skipped when the current mask collapsed (Fix 1
      // holds the last good pair instead), so a dropout is never smeared in.
      const auto emaStart = std::chrono::steady_clock::now();
      if (settings.temporalBlendEnabled && rawCoverage >= kMinForegroundCoverage &&
          rawCoverage <= kMaxForegroundCoverage) {
        blendAlphaEma(keyed.mask, previousMask);
      }
      keyed.status.metrics.maskTemporalMs =
          temporalPreMs + elapsedMs(emaStart, std::chrono::steady_clock::now());
      keyed.status.metrics.maskPostprocessMs += refineMs;
      keyed.status.metrics.maskWidth = keyed.mask.width;
      keyed.status.metrics.maskHeight = keyed.mask.height;
      bool shouldPublish = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        shouldPublish = !stopping_ && running_.load() && generation == generation_;
        if (shouldPublish) {
          const auto now = std::chrono::steady_clock::now();
          const uint64_t publishNs = nowNs();
          keyerRate_.tick(now);
          updateDropRateLocked(now);
          keyed.status.metrics.droppedFrames = droppedFrames_;
          keyed.status.metrics.skippedFrames = skippedFrames_;
          keyed.status.metrics.keyerFps = keyerRate_.value(now);
          keyed.status.metrics.droppedFramesPerSec = droppedFramesPerSec_;
          keyed.status.metrics.keyerInputAgeMs = frame.timestampNs > 0u && keyerStartNs >= frame.timestampNs
              ? static_cast<double>(keyerStartNs - frame.timestampNs) / 1000000.0
              : -1.0;
          keyed.status.metrics.keyerProcessingMs = publishNs >= keyerStartNs
              ? static_cast<double>(publishNs - keyerStartNs) / 1000000.0
              : -1.0;
          // Collapse guard: a (near-)empty mask, or a mask whose coverage
          // suddenly collapses versus the last good one, is a Vision dropout —
          // keep the last good pair instead of keying the person out. The
          // program loop ages the held pair out after maxMaskAgeMs, so a truly
          // absent person still falls back to the un-keyed camera.
          const bool collapsed =
              rawCoverage < kMinForegroundCoverage ||
              rawCoverage > kMaxForegroundCoverage ||
              (lastPublishedCoverage_ > kHealthyCoverage &&
               rawCoverage < lastPublishedCoverage_ * kCollapseDropRatio);
          // Subject-presence tracking (Option A): a coverage collapse that
          // persists across acceptAfterMs of SUCCESSFUL inference is a person
          // who actually left the frame, not a dropout. PUBLISH that (empty)
          // mask flagged as valid - with fresh publish stamps the retention
          // stays in Apply and the compositor keeps the background up -
          // instead of holding the last pair forever (which ended in
          // stale_hold/passthrough, i.e. "the keyer turns off"). Inference
          // failures (empty result mask) never advance the streak, so the
          // dropout hold stays intact. Over-full and sudden-drop masks stay
          // dropouts (coverage above the floor resets the streak). Shared
          // with macOS BY DESIGN: there this worker only matters when CoreML
          // failed, where background-only is the desired Option-A behavior
          // as well.
          const SubjectPresence presence = presenceTracker_.feed(
              rawCoverage, !keyed.mask.alpha.empty(),
              std::chrono::duration<double, std::milli>(now.time_since_epoch())
                  .count());
          const bool confirmedEmpty =
              presence == SubjectPresence::ConfirmedEmpty &&
              rawCoverage < kMinForegroundCoverage;
          if (!keyed.mask.alpha.empty() && (!collapsed || confirmedEmpty)) {
            keyed.mask.emptyValid = confirmedEmpty;
            auto pair = std::make_shared<PairedKeyerFrame>();
            pair->frame = std::move(frame);
            pair->mask = std::move(keyed.mask);
            pair->publishedAtNs = publishNs;
            pair->inferenceMs = keyed.status.inferenceMs;
            latestPair_ = std::move(pair);
            lastPublishedCoverage_ = rawCoverage;
          } else if (latestPair_ == nullptr) {
            // No good mask to fall back to yet (startup): reset so the program
            // loop shows the un-keyed camera rather than a stale frame.
            latestPair_.reset();
          }
          // else: hold the last good pair (skip publishing the broken mask).
        }
      }
      if (shouldPublish) {
        updateMeetingKeyerStatus(state_, keyed.status);
      }

      const double processingMs = static_cast<double>(nowNs() - keyerStartNs) / 1000000.0;
      // The duty-cycle cooldown leaves CPU headroom on machines where a keyer
      // pass is CPU-bound. When inference runs on the GPU (CoreML/DirectML) the
      // CPU is idle during the pass, so the cooldown would only add mask-age
      // latency without protecting anything — skip it for GPU-backed keyers.
      const bool gpuInference = keyed.status.provider == "coreml" ||
                                keyed.status.provider == "directml";
      if (running_.load() && !gpuInference &&
          processingMs > frameIntervalMs_ * kKeyerCooldownTriggerFactor) {
        const double cooldownMs = std::min(kKeyerMaxCooldownMs, processingMs * kKeyerCooldownFraction);
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(cooldownMs));
      }
    }
  }

  void updateDropRateLocked(const std::chrono::steady_clock::time_point now) {
    if (lastDropRateSample_ == std::chrono::steady_clock::time_point{}) {
      lastDropRateSample_ = now;
      lastDropRateTotal_ = droppedFrames_;
      return;
    }
    const double elapsedMs = std::chrono::duration<double, std::milli>(now - lastDropRateSample_).count();
    if (elapsedMs < kMetricsWindowMs) {
      return;
    }
    const uint64_t droppedDelta = droppedFrames_ >= lastDropRateTotal_ ? droppedFrames_ - lastDropRateTotal_ : 0u;
    droppedFramesPerSec_ = static_cast<double>(droppedDelta) * 1000.0 / std::max(1.0, elapsedMs);
    lastDropRateTotal_ = droppedFrames_;
    lastDropRateSample_ = now;
  }

  KeyerChain keyerChain_;
  MeetingState &state_;
  std::atomic<bool> &running_;
  const double frameIntervalMs_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
  VideoFrame pendingFrame_;
  std::shared_ptr<const PairedKeyerFrame> latestPair_;
  double lastPublishedCoverage_ = 0.0;
  // Fed and reset under mutex_ only (feed in the publish section, reset in
  // clear()), so the program loop's clear() cannot race the worker thread.
  SubjectPresenceTracker presenceTracker_{subjectPresenceConfigFromEnv()};
  uint64_t generation_ = 0;
  uint64_t pendingGeneration_ = 0;
  uint64_t droppedFrames_ = 0;
  uint64_t skippedFrames_ = 0;
  RateMeter keyerRate_;
  std::chrono::steady_clock::time_point lastDropRateSample_{};
  uint64_t lastDropRateTotal_ = 0u;
  double droppedFramesPerSec_ = -1.0;
  bool hasPendingFrame_ = false;
  bool stopping_ = false;
};

class GraphicsFrameBusReader {
 public:
  explicit GraphicsFrameBusReader(std::string name) : name_(std::move(name)) {}

  ~GraphicsFrameBusReader() {
    close();
  }

  bool copyLatest(VideoFrame &frame, bool enabled) {
    if (!enabled) {
      close();
      hasLatestFrame_ = false;
      latestFrame_ = VideoFrame{};
      return false;
    }
    ensureOpen();
    if (reader_ == nullptr) {
      return hasLatestFrame_;
    }
    if (lastProgressNs_ == 0u) {
      lastProgressNs_ = nowNs();
    }

    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fps = 0;
    if (framebus_reader_get_info(reader_, &width, &height, &fps) != 0 || width == 0u || height == 0u) {
      logReaderEvent("info_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }

    const size_t requiredSize = static_cast<size_t>(width) * height * 4u;
    if (scratch_.size() != requiredSize) {
      scratch_.assign(requiredSize, 0u);
    }
    const int result = framebus_reader_copy_latest_rgba(reader_, scratch_.data(), static_cast<size_t>(width) * 4u, &lastSeq_);
    if (result == -1) {
      logReaderEvent("copy_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }
    if (result == 1) {
      uint64_t nonTransparentPixels = 0;
      uint32_t maxAlpha = 0;
      const bool shouldSampleAlpha = lastSeq_ == 1u || lastSeq_ % 300u == 0u;
      if (shouldSampleAlpha) {
        for (size_t index = 3; index < scratch_.size(); index += 4u) {
          const uint32_t alpha = scratch_[index];
          if (alpha > 0u) {
            ++nonTransparentPixels;
            maxAlpha = std::max(maxAlpha, alpha);
          }
        }
      }
      latestFrame_.width = width;
      latestFrame_.height = height;
      latestFrame_.timestampNs = nowNs();
      latestFrame_.rgba = scratch_;
      hasLatestFrame_ = true;
      lastProgressNs_ = nowNs();
      if (shouldSampleAlpha) {
        logReaderEvent("frame_read", width, height, fps, nonTransparentPixels, maxAlpha);
      }
    } else if (result == 0) {
      // Self-heal a stale mapping: the graphics renderer recreates the shared
      // memory segment on restart/reconfigure (shm_unlink + create). A reader
      // that stays mapped to the orphaned segment would silently never see a
      // frame again, so after a quiet period re-open by name to attach to the
      // current segment. The cached last frame keeps displaying meanwhile.
      const uint64_t now = nowNs();
      if (now - lastProgressNs_ > kStaleReopenNs) {
        logReaderEvent("stale_reopen", width, height, fps, 0, 0);
        close();
        lastProgressNs_ = now;
      }
    }

    if (hasLatestFrame_) {
      frame = latestFrame_;
    }
    return hasLatestFrame_;
  }

 private:
  // Re-open a quiet reader after 2s so a renderer restart (which recreates
  // the shared memory segment) cannot orphan this reader permanently.
  static constexpr uint64_t kStaleReopenNs = 2'000'000'000ull;

  void ensureOpen() {
    if (reader_ != nullptr) {
      return;
    }
    reader_ = framebus_reader_open(name_.c_str());
    lastSeq_ = 0;
    if (reader_ == nullptr) {
      logReaderEvent("open_failed", 0, 0, 0, 0, 0);
    } else {
      logReaderEvent("opened", 0, 0, 0, 0, 0);
    }
  }

  void close() {
    if (reader_ != nullptr) {
      framebus_reader_close(reader_);
      reader_ = nullptr;
      logReaderEvent("closed", 0, 0, 0, 0, 0);
    }
    lastSeq_ = 0;
  }

  void logReaderEvent(const char *event,
                      uint32_t width,
                      uint32_t height,
                      uint32_t fps,
                      uint64_t nonTransparentPixels,
                      uint32_t maxAlpha) {
    // The gate suppresses the repeating idle stale-reopen cycle and rate
    // limits identical events; seq changes always pass through.
    if (!logGate_.shouldLog(event, lastSeq_, width, height, nowNs())) {
      return;
    }
    std::cout << "{\"type\":\"meeting_graphics_framebus\",\"event\":\"" << event
              << "\",\"name\":\"" << name_
              << "\",\"seq\":" << lastSeq_
              << ",\"width\":" << width
              << ",\"height\":" << height
              << ",\"fps\":" << fps
              << ",\"non_transparent_pixels\":" << nonTransparentPixels
              << ",\"max_alpha\":" << maxAlpha
              << "}" << std::endl;
  }

  framebus_reader_t *reader_ = nullptr;
  uint64_t lastSeq_ = 0;
  uint64_t lastProgressNs_ = 0;
  FramebusReaderLogGate logGate_;
  std::string name_;
  bool hasLatestFrame_ = false;
  VideoFrame latestFrame_;
  std::vector<uint8_t> scratch_;
};

}  // namespace

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      MeetingRecorder &recorder,
                      std::atomic<bool> &running) {
#if defined(_WIN32)
  ScopedWinMmcss programThreadQos(L"Capture");
  std::unique_ptr<ScopedWinTimerResolution> liveTimerResolution;
#endif
  framebus_writer_t *writer = framebus_writer_open(
      options.framebusName.c_str(), options.width, options.height, options.fps, kSlotCount);
  if (writer == nullptr) {
    std::cout << "{\"type\":\"error\",\"code\":\"framebus_open_failed\",\"message\":\"Could not create FrameBus segment.\"}" << std::endl;
    return;
  }

  const uint32_t targetFps = options.fps == 0 ? 30u : options.fps;
  const auto frameInterval = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
      std::chrono::duration<double>(1.0 / static_cast<double>(targetFps)));
  auto nextFrameAt = std::chrono::steady_clock::now();
  uint64_t frameIndex = 0;
  std::vector<uint8_t> programFrame;
  VideoFrame latestCameraFrame;
  VideoFrame latestPipFrame;
  uint64_t lastPipCameraTimestampNs = 0u;
  uint64_t lastCameraTimestampNs = 0u;
  uint64_t lastProgramRevision = 0u;
  uint64_t lastUsedKeyerPublishedNs = 0u;
  uint64_t lastBackGraphicsTimestampNs = 0u;
  uint64_t lastFrontGraphicsTimestampNs = 0u;
  auto lastStaticHeartbeatAt = std::chrono::steady_clock::time_point{};
  auto cameraWatchdogStartAt = std::chrono::steady_clock::time_point{};
  auto lastCameraFrameAt = std::chrono::steady_clock::time_point{};
  bool cameraStallReported = false;
  AsyncKeyerWorker keyerWorker(options, state, running);
  GraphicsFrameBusReader backGraphicsReader(kMeetingBackGraphicsFrameBusName);
  GraphicsFrameBusReader frontGraphicsReader(kMeetingFrontGraphicsFrameBusName);
  RateMeter programRate;
  RollingAverage maskAgeAverage;
#if defined(_WIN32)
  // Async/lite mask retention (field fix 2026-08-09): the mask-age gate
  // adapts to the real publish cadence and holds a stale mask (age-faded)
  // instead of hard-expiring it, so a slow-but-healthy keyer no longer flaps
  // between keyed and un-keyed frames. Windows-scoped: macOS keeps the tuned
  // hard-expiry behavior byte-identically.
  MaskRetention asyncMaskRetention;
#endif
  AutoDirector autoDirector;
  uint64_t previousProgramStartNs = 0u;
  while (running.load()) {
    PipelineRuntimeState runtime;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.cameraRunning = camera.isRunning();
      state.activeCameraIndex = camera.activeCameraIndex();
      runtime.cameraRunning = state.cameraRunning;
      runtime.keyerEnabled = state.keyerEnabled;
      runtime.framebusRunning = state.framebusRunning;
      runtime.previewClients = state.previewClientCount;
      runtime.vcamClients = state.vcamClientCount;
      runtime.programDirty = state.programDirty;
      runtime.graphicsDirty = state.graphicsDirty;
      runtime.programRevision = state.programRevision;
      runtime.pipCameraIndex = state.pipCameraIndex;
      runtime.autoDirectorEnabled = state.autoDirectorEnabled;
      runtime.autoDirectorThreshold = state.autoDirectorThreshold;
    }

    // Conference auto-director: cut the program to the loudest camera. Runs
    // before rendering so a cut takes effect on this very frame. The evaluator
    // enforces its own dwell/hold hysteresis; toggling it off clears any
    // in-progress challenger so it starts fresh next time.
    if (runtime.autoDirectorEnabled && runtime.cameraRunning) {
      const int decided = autoDirector.evaluate(
          camera.cameraAudioLevels(), camera.activeCameraIndex(),
          runtime.autoDirectorThreshold, std::chrono::steady_clock::now());
      if (decided >= 0 && camera.setProgramCamera(decided)) {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.activeCameraIndex = decided;
        state.programDirty = true;
      }
    } else {
      autoDirector.reset();
    }

    const CompositorSnapshot snapshot = copyCompositorSnapshot(state);
    runtime.mode = determinePipelineMode(runtime, snapshot);
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.pipelineMode = runtime.mode;
    }
#if defined(_WIN32)
    const bool liveTimerNeeded =
        runtime.mode == "live" || runtime.mode == "keyer_live";
    if (liveTimerNeeded && liveTimerResolution == nullptr) {
      liveTimerResolution = std::make_unique<ScopedWinTimerResolution>();
    } else if (!liveTimerNeeded && liveTimerResolution != nullptr) {
      liveTimerResolution.reset();
    }
#endif

    if (runtime.mode == "idle" && !runtime.programDirty && programFrame.empty()) {
      std::this_thread::sleep_for(kIdleSleep);
      nextFrameAt = std::chrono::steady_clock::now();
      continue;
    }

    const bool outputConsumerActive = hasActiveOutputConsumer(runtime);
    const bool previewConsumerActive = runtime.previewClients > 0 || runtime.vcamClients > 0;
    const auto programStart = std::chrono::steady_clock::now();
    const bool staticHeartbeatDue =
        lastStaticHeartbeatAt == std::chrono::steady_clock::time_point{} ||
        programStart - lastStaticHeartbeatAt >= kStaticHeartbeatInterval;
    const bool programChanged =
        runtime.programDirty || runtime.programRevision != lastProgramRevision ||
        programFrame.empty();
    bool shouldRenderProgram = programChanged;
    bool shouldPublishPreview = false;
    bool shouldWriteFramebus = false;

    {
      const uint64_t programStartNs = nowNs();
      const double programFrameIntervalMs = previousProgramStartNs > 0u && programStartNs >= previousProgramStartNs
          ? static_cast<double>(programStartNs - previousProgramStartNs) / 1000000.0
          : -1.0;
      previousProgramStartNs = programStartNs;
      const auto cameraCopyStart = std::chrono::steady_clock::now();
      // Copy straight into latestCameraFrame: the intermediate local frame
      // cost an extra full-frame copy (~3.7 MB) per camera frame.
      const bool hasNewCameraFrame = runtime.cameraRunning &&
          camera.copyLatestFrameIfNew(lastCameraTimestampNs, latestCameraFrame) &&
          !latestCameraFrame.rgba.empty();
      if (hasNewCameraFrame) {
        lastCameraTimestampNs = latestCameraFrame.timestampNs;
        lastCameraFrameAt = programStart;
        cameraWatchdogStartAt = programStart;
        if (cameraStallReported) {
          std::cout << "{\"type\":\"camera_recovered\"}" << std::endl;
          std::lock_guard<std::mutex> lock(state.mutex);
          state.cameraStalled = false;
          cameraStallReported = false;
        }
      } else if (!runtime.cameraRunning) {
        latestCameraFrame = VideoFrame{};
        lastCameraTimestampNs = 0u;
        lastCameraFrameAt = std::chrono::steady_clock::time_point{};
        cameraWatchdogStartAt = std::chrono::steady_clock::time_point{};
        cameraStallReported = false;
        std::lock_guard<std::mutex> lock(state.mutex);
        state.cameraStalled = false;
      } else {
        if (cameraWatchdogStartAt == std::chrono::steady_clock::time_point{}) {
          cameraWatchdogStartAt = programStart;
        }
        const auto ageStart =
            lastCameraFrameAt == std::chrono::steady_clock::time_point{}
                ? cameraWatchdogStartAt
                : lastCameraFrameAt;
        const auto age = programStart - ageStart;
        if (!cameraStallReported &&
            isCameraFrameStalled(programStart, lastCameraFrameAt,
                                 cameraWatchdogStartAt, kCameraStallWindow)) {
          const auto ageMs =
              std::chrono::duration_cast<std::chrono::milliseconds>(age).count();
          std::cout << "{\"type\":\"camera_stalled\",\"age_ms\":" << ageMs
                    << "}" << std::endl;
          {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.cameraStalled = true;
          }
          cameraStallReported = true;
#if defined(_WIN32)
          camera.reopen(options.width, options.height, options.fps);
#endif
        }
      }

      // Conference PiP: a second open camera drawn as an inset. Read its
      // newest frame if configured and distinct from the program camera.
      const bool pipActive = runtime.cameraRunning &&
                             runtime.pipCameraIndex >= 0 &&
                             runtime.pipCameraIndex != camera.activeCameraIndex();
      if (pipActive) {
        camera.copyLatestFrameFrom(runtime.pipCameraIndex,
                                   lastPipCameraTimestampNs, latestPipFrame);
        if (!latestPipFrame.rgba.empty()) {
          lastPipCameraTimestampNs = latestPipFrame.timestampNs;
        }
      } else {
        latestPipFrame = VideoFrame{};
        lastPipCameraTimestampNs = 0u;
      }
      const bool hasCameraFrame = runtime.cameraRunning && !latestCameraFrame.rgba.empty();
      const auto cameraCopyEnd = std::chrono::steady_clock::now();
      const VideoFrame *frameForCompositor = nullptr;
      std::shared_ptr<const PairedKeyerFrame> selectedPair;
      KeyerSettings keyerSettings;
      bool keyerEnabled = false;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        keyerEnabled = state.keyerEnabled;
        keyerSettings.qualityMode = state.qualityMode;
        keyerSettings.maskErodePx = state.maskErodePx;
        keyerSettings.maskDilatePx = state.maskDilatePx;
        keyerSettings.maskFeatherPx = state.maskFeatherPx;
        keyerSettings.dynamicDilation = state.dynamicDilation;
        keyerSettings.temporalBlendEnabled = state.temporalBlendEnabled;
        keyerSettings.edgeStabilizationEnabled = state.edgeStabilizationEnabled;
        keyerSettings.edgeStabilizationStrength = state.edgeStabilizationStrength;
        keyerSettings.degradation = state.degradationSettings;
        keyerSettings.performanceMode = state.performanceMode;
      }
      // The fused path keys synchronously below; don't also run the async worker
      // (that would run the model twice per frame). While the fused keyer is
      // degraded, the async worker takes over - it must receive frames or the
      // fallback can never produce a mask (K-03).
      const bool asyncPathActive = !gpuPipelineEnabled() || g_fusedKeyerDegraded;
      if (hasNewCameraFrame && keyerEnabled && asyncPathActive) {
        keyerWorker.submit(latestCameraFrame);
      }
      if (hasCameraFrame) {
        if (snapshot.keyerEnabled) {
          if (!asyncPathActive) {
            // The fused path owns the keyer this frame (same predicate as the
            // submit guard above): never consume or REPORT the parked async
            // worker's pair. Before this gate, the worker's last pair aged
            // unbounded across a lite->fused step-up and this block kept
            // overwriting the fused telemetry (mask age, keyer fps,
            // degradation stage, publish-to-program) every frame - the UI
            // sampled the stale values in the window before the blocking
            // fused inference corrected them. The fused block below sets the
            // compositor inputs; the un-keyed live camera is the safe default
            // should it fail this very frame. BROADIFY_MEETING_GPU_PIPELINE=0
            // restores the pure async behavior.
            frameForCompositor = &latestCameraFrame;
          } else if (const std::shared_ptr<const PairedKeyerFrame> latestPair = keyerWorker.copyLatest()) {
            double maskAgeMs = 0.0;
            if (latestCameraFrame.timestampNs >= latestPair->frame.timestampNs) {
              maskAgeMs = static_cast<double>(latestCameraFrame.timestampNs - latestPair->frame.timestampNs) / 1000000.0;
            }
            maskAgeAverage.add(maskAgeMs);
#if defined(_WIN32)
            // Adaptive retention instead of hard expiry: a mask over the gate
            // is HELD (stale_hold, age-faded) until the hard cap, so the keyer
            // no longer visibly turns off/on around the age gate.
            const MaskRetentionDecision retention = asyncMaskRetention.decide(
                latestCameraFrame.timestampNs, latestPair->publishedAtNs,
                maskAgeMs, std::max(0.0, keyerSettings.degradation.maxMaskAgeMs));
            const bool pairIsUsable = retention != MaskRetentionDecision::Passthrough;
#else
            const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
#endif
            if (pairIsUsable) {
              selectedPair = latestPair;
              frameForCompositor = &selectedPair->frame;
            } else {
              frameForCompositor = &latestCameraFrame;
            }
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            // Step-down overlap mute: while the fused keyer bridges the
            // overlap (previous frame's phase, see the flag), the fused
            // section owns the published telemetry — these per-frame writes
            // would interleave warming-worker values (stage "passthrough",
            // near-zero keyerFps) into what UI polls sample. Submit and
            // copyLatest above still ran, so the worker keeps warming and
            // the cutover's first-pair detection is unaffected.
            if (!g_fusedStepDownOverlapActive) {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.keyerMetrics.maskAgeMs = maskAgeMs;
              state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
              state.keyerMetrics.keyerPublishToProgramMs = latestPair->publishedAtNs > 0u && programStartNs >= latestPair->publishedAtNs
                  ? static_cast<double>(programStartNs - latestPair->publishedAtNs) / 1000000.0
                  : -1.0;
              state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
              state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
              state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
              state.keyerMetrics.keyerFps = keyerStats.keyerFps;
              if (pairIsUsable && latestPair->mask.emptyValid) {
                // Confirmed-empty subject (Option A): the background stays
                // composited on purpose - never report this as
                // passthrough/stale_hold.
                state.degradationStage = "no_subject";
                state.staleMaskActive = false;
              } else if (pairIsUsable) {
#if defined(_WIN32)
                if (retention == MaskRetentionDecision::StaleHold) {
                  state.degradationStage = "stale_hold";
                  state.staleMaskActive = true;
                } else {
                  state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
                  state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
                }
#else
                state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
                state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
#endif
              } else {
                state.degradationStage = "passthrough";
                state.staleMaskActive = true;
              }
            }
          } else {
            frameForCompositor = &latestCameraFrame;
            const KeyerRuntimeStats keyerStats = keyerWorker.stats();
            // Same step-down overlap mute as the pair branch above: the
            // worker has no pair yet exactly BECAUSE it is still warming —
            // reporting "passthrough" here while fused is on air is the bug.
            if (!g_fusedStepDownOverlapActive) {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.degradationStage = "passthrough";
              state.staleMaskActive = false;
              state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
              state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
              state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
              state.keyerMetrics.keyerFps = keyerStats.keyerFps;
            }
          }
        } else {
          keyerWorker.clear();
          maskAgeAverage.clear();
#if defined(_WIN32)
          asyncMaskRetention.reset();
#endif
          frameForCompositor = &latestCameraFrame;
          {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.degradationStage = "fresh";
            state.staleMaskActive = false;
            state.keyerMetrics.maskAgeAvgMs = -1.0;
          }
        }
      } else {
        keyerWorker.clear();
        maskAgeAverage.clear();
#if defined(_WIN32)
        asyncMaskRetention.reset();
#endif
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.degradationStage = "passthrough";
          state.staleMaskActive = false;
          state.keyerMetrics.maskAgeAvgMs = -1.0;
        }
      }
      VideoFrame backGraphicsFrame;
      VideoFrame frontGraphicsFrame;
      const bool graphicsOutputActive = isGraphicsOutputActive(snapshot);
      const VideoFrame *backGraphicsFrameForCompositor =
          backGraphicsReader.copyLatest(backGraphicsFrame, graphicsOutputActive) ? &backGraphicsFrame : nullptr;
      const VideoFrame *frontGraphicsFrameForCompositor =
          frontGraphicsReader.copyLatest(frontGraphicsFrame, graphicsOutputActive) ? &frontGraphicsFrame : nullptr;
      const bool hasNewBackGraphicsFrame = backGraphicsFrameForCompositor != nullptr &&
          backGraphicsFrameForCompositor->timestampNs != 0u &&
          backGraphicsFrameForCompositor->timestampNs != lastBackGraphicsTimestampNs;
      const bool hasNewFrontGraphicsFrame = frontGraphicsFrameForCompositor != nullptr &&
          frontGraphicsFrameForCompositor->timestampNs != 0u &&
          frontGraphicsFrameForCompositor->timestampNs != lastFrontGraphicsTimestampNs;
      if (hasNewBackGraphicsFrame) {
        lastBackGraphicsTimestampNs = backGraphicsFrameForCompositor->timestampNs;
      }
      if (hasNewFrontGraphicsFrame) {
        lastFrontGraphicsTimestampNs = frontGraphicsFrameForCompositor->timestampNs;
      }
      const bool graphicsChanged = runtime.graphicsDirty ||
          hasNewBackGraphicsFrame || hasNewFrontGraphicsFrame;
      const PipelineWorkTriggers workTriggers{
          hasNewCameraFrame, programChanged, graphicsChanged};
      const bool programWorkDue = shouldRunProgramWork(workTriggers);
      const bool fusedKeyerWorkDue = shouldRunFusedKeyerWork(workTriggers);
      // Same-frame re-evaluation only while the async path is the active
      // source (see the gate above): while fused owns the keyer this block
      // must neither consume the parked worker's pair nor write telemetry.
      if (hasCameraFrame && snapshot.keyerEnabled && asyncPathActive) {
        const std::shared_ptr<const PairedKeyerFrame> latestPair = keyerWorker.copyLatest();
        if (latestPair != nullptr &&
            (selectedPair == nullptr || latestPair->publishedAtNs > selectedPair->publishedAtNs)) {
          double maskAgeMs = 0.0;
          if (latestCameraFrame.timestampNs >= latestPair->frame.timestampNs) {
            maskAgeMs = static_cast<double>(latestCameraFrame.timestampNs - latestPair->frame.timestampNs) / 1000000.0;
          }
          maskAgeAverage.add(maskAgeMs);
#if defined(_WIN32)
          // Same-frame re-evaluation with the fresher pair; the retention
          // helper dedupes the passthrough streak by frame timestamp.
          const MaskRetentionDecision retention = asyncMaskRetention.decide(
              latestCameraFrame.timestampNs, latestPair->publishedAtNs,
              maskAgeMs, std::max(0.0, keyerSettings.degradation.maxMaskAgeMs));
          const bool pairIsUsable = retention != MaskRetentionDecision::Passthrough;
#else
          const bool pairIsUsable = maskAgeMs <= std::max(0.0, keyerSettings.degradation.maxMaskAgeMs);
#endif
          if (pairIsUsable) {
            selectedPair = latestPair;
            frameForCompositor = &selectedPair->frame;
          } else {
            frameForCompositor = &latestCameraFrame;
            selectedPair.reset();
          }
          const KeyerRuntimeStats keyerStats = keyerWorker.stats();
          const uint64_t programUseNs = nowNs();
          // Step-down overlap mute, same as the first async block: the pair
          // selection above still runs (cutover freshness), only the
          // published telemetry stays with the fused on-air path.
          if (!g_fusedStepDownOverlapActive) {
            std::lock_guard<std::mutex> lock(state.mutex);
            state.keyerMetrics.maskAgeMs = maskAgeMs;
            state.keyerMetrics.maskAgeAvgMs = maskAgeAverage.value();
            state.keyerMetrics.keyerPublishToProgramMs = latestPair->publishedAtNs > 0u && programUseNs >= latestPair->publishedAtNs
                ? static_cast<double>(programUseNs - latestPair->publishedAtNs) / 1000000.0
                : -1.0;
            state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
            state.keyerMetrics.droppedFrames = keyerStats.droppedFramesTotal;
            state.keyerMetrics.skippedFrames = keyerStats.skippedFramesTotal;
            state.keyerMetrics.droppedFramesPerSec = keyerStats.droppedFramesPerSec;
            state.keyerMetrics.keyerFps = keyerStats.keyerFps;
            if (pairIsUsable && latestPair->mask.emptyValid) {
              // Confirmed-empty subject (Option A): see the first block.
              state.degradationStage = "no_subject";
              state.staleMaskActive = false;
            } else if (pairIsUsable) {
#if defined(_WIN32)
              if (retention == MaskRetentionDecision::StaleHold) {
                state.degradationStage = "stale_hold";
                state.staleMaskActive = true;
              } else {
                state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
                state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
              }
#else
              state.degradationStage = maskAgeMs < keyerSettings.degradation.freshMaskAgeMs ? "fresh" : "paired";
              state.staleMaskActive = maskAgeMs >= keyerSettings.degradation.freshMaskAgeMs;
#endif
            } else {
              state.degradationStage = "passthrough";
              state.staleMaskActive = true;
            }
          }
        }
      }

      const bool hasNewUsableKeyerPair = selectedPair != nullptr && selectedPair->publishedAtNs > lastUsedKeyerPublishedNs;
      shouldRenderProgram = shouldRenderProgram ||
          programWorkDue ||
          hasNewUsableKeyerPair;
      if (runtime.mode == "idle" && !outputConsumerActive && !shouldRenderProgram) {
        std::this_thread::sleep_for(kIdleSleep);
        nextFrameAt = std::chrono::steady_clock::now();
        continue;
      }
      if (runtime.mode == "static_output" && !shouldRenderProgram && !staticHeartbeatDue) {
        std::this_thread::sleep_for(kStaticPollInterval);
        nextFrameAt = std::chrono::steady_clock::now();
        continue;
      }

      // Live-frame edge-snap: the selected keyer pair carries the OLDER frame it
      // was computed on. Compositing that old frame is what the user sees as
      // latency on motion. Instead composite the LIVE camera frame and snap the
      // (slightly old) mask onto its real edges with the guided filter, so the
      // boundary is re-locked to the current frame every program frame. Only
      // runs when a genuinely fresher live frame exists (else it is a no-op);
      // the still path is untouched. Falls back to the paired mask on any issue.
      AlphaMask liveRefinedMask;
      const AlphaMask *maskForCompositor =
          selectedPair != nullptr ? &selectedPair->mask : nullptr;
      // Confirmed-empty masks skip the snap entirely (refining zeros is
      // wasted work); the pair's flagged zero mask goes to the compositor.
      if (fusedKeyerWorkDue && selectedPair != nullptr && snapshot.keyerEnabled && hasCameraFrame &&
          !latestCameraFrame.rgba.empty() && !selectedPair->mask.alpha.empty() &&
          !selectedPair->mask.emptyValid && guidedRefineAvailable()) {
        const bool fresherFrame =
            latestCameraFrame.timestampNs > selectedPair->frame.timestampNs;
        // Edge-live carries no worker-side refine, so it must clean the edge on
        // EVERY frame — otherwise the edge quality beats in and out as keyer and
        // program fps drift through phase (~1Hz). The plain live-snap only needs
        // to run when a fresher frame exists (else the paired mask already
        // carries the worker refine).
        const bool run =
            edgeLiveEnabled() ? true : (liveSnapEnabled() && fresherFrame);
        if (run) {
          liveRefinedMask = selectedPair->mask;  // pair is shared/immutable
          // Guide with the live frame when we have a fresher one (motion-
          // aligned); otherwise the mask's own paired frame (still cleans the
          // edge, no beat).
          const VideoFrame &guide =
              fresherFrame ? latestCameraFrame : selectedPair->frame;
#if defined(_WIN32)
          // GPU guided refine (BROADIFY_MEETING_GPU_GUIDED=1): same math on
          // the D3D11 device; the CPU refine stays as fallback and reference.
          if (!(d3d11GuidedRefineAvailable() &&
                guidedRefineMaskD3D11(liveRefinedMask, guide))) {
            guidedRefineMask(liveRefinedMask, guide);
          }
#else
          guidedRefineMask(liveRefinedMask, guide);
#endif
          // The guided snap aligns the edge but leaves it soft (bleed); sharpen
          // it into a crisp boundary in edge-live mode.
          if (edgeLiveEnabled()) {
            sharpenAlphaEdge(liveRefinedMask);
          }
          if (!liveRefinedMask.alpha.empty()) {
            if (fresherFrame) {
              // KEY-02: the refined mask belongs to the CURRENT frame now.
              // The GPU compositors cache mask uploads by timestampNs
              // (metal_compositor / d3d11_compositor) - with the old paired
              // stamp they would keep compositing the stale texture.
              liveRefinedMask.timestampNs = latestCameraFrame.timestampNs;
              frameForCompositor = &latestCameraFrame;
            }
            maskForCompositor = &liveRefinedMask;
          }
        }
      }

      // Fused synchronous GPU keyer: key the CURRENT frame now (mask age 0) via
      // the native CoreML keyer, overriding the async selection. Falls back to
      // whatever the async path chose on any failure.
      AlphaMask fusedMask;
#if defined(__APPLE__)
      if (gpuPipelineEnabled() && fusedKeyerWorkDue && hasCameraFrame && snapshot.keyerEnabled &&
          !latestCameraFrame.rgba.empty()) {
        static CoreMLKeyer fusedKeyer(options.modelsDir);
        KeyerResult fused = fusedKeyer.apply(latestCameraFrame, keyerSettings);
        if (!fused.status.fallbackActive && !fused.mask.alpha.empty()) {
          g_fusedKeyerDegraded = false;
          fusedMask = std::move(fused.mask);
          // Dropout guard only (no EMA): keeps the tuned macOS look, but a
          // model dropout no longer blanks the presenter for a frame (KEY-03).
          stabilizeFusedMask(fusedMask, /*applyEma=*/false);
          frameForCompositor = &latestCameraFrame;
          maskForCompositor = &fusedMask;
          shouldRenderProgram = true;
          updateMeetingKeyerStatus(state, fused.status);
          std::lock_guard<std::mutex> lock(state.mutex);
          state.keyerMetrics.maskAgeMs = 0.0;
          state.keyerMetrics.maskAgeAvgMs = 0.0;
          state.degradationStage = "fused";
          state.staleMaskActive = false;
        } else {
          // Publish the failure instead of freezing silently (K-03): the
          // status stream now reports fallback_active + reason, and the async
          // Vision fallback starts receiving frames (submit guard above).
          g_fusedKeyerDegraded = true;
          updateMeetingKeyerStatus(state, fused.status);
        }
      }
#elif defined(_WIN32)
      {
        // Auto-degradation governor + inference cadence for the fused path.
        // Program-loop-thread-only statics, like the fused keyer itself.
        // Retained between frames: the post-stabilize / pre-guided-refine
        // matte of the last real inference, its source frame timestamp, and a
        // luma thumbnail of that frame (motion reference for the cadence).
        static KeyerAutoGovernor fusedGovernor(makeFusedGovernorConfig(targetFps));
        static FusedCadenceController fusedCadence(makeFusedCadenceConfig(targetFps));
        static AlphaMask lastFusedRawMask;
        static uint64_t lastFusedInferredTsNs = 0u;
        static LumaThumb lastFusedInferredLuma;
        static LumaThumb currentFrameLuma;
        // Last PUBLISHED (post-postprocess) fused mask: the previous-mask
        // input for the fused postprocess parity (stabilizeAlphaEdges needs
        // temporal continuity). Reset wherever lastFusedRawMask is reset.
        static AlphaMask lastFusedPublishedMask;
        // Warm-handover state (make-before-break tier transitions, see
        // warmHandoverEnabled). The handover machine and the thread holder
        // are program-thread-only; the warmup worker thread communicates
        // exclusively through the two atomics below.
        static TierHandover fusedHandover;
        // Holder instead of a bare static std::thread: a warmup still running
        // at process exit would make ~thread() call std::terminate. Detaching
        // at static destruction lets the process exit cleanly; the thread
        // only touches process-lifetime statics (fused keyer + atomics).
        // COUPLING: this safety relies on main.cpp shutting down via
        // std::_Exit(0), which skips ALL static destructors — including the
        // static fusedKeyer below that a still-detached warmup thread may be
        // using. Replacing std::_Exit with a normal return from main would
        // destroy the fused keyer under that running thread (shutdown
        // use-after-free); see the matching comment at the _Exit call site.
        struct FusedWarmupThreadHolder {
          std::thread thread;
          ~FusedWarmupThreadHolder() {
            if (thread.joinable()) {
              thread.detach();
            }
          }
        };
        static FusedWarmupThreadHolder fusedWarmupThreadHolder;
        std::thread &fusedWarmupThread = fusedWarmupThreadHolder.thread;
        // true from just before the warmup thread spawns until the LAST
        // statement of its body; the program thread joins ONLY while false,
        // so join() always returns immediately and a running session build
        // (up to ~12s) can never block the program loop.
        static std::atomic<bool> fusedWarmupBusy{false};
        // 1 = warmup succeeded, -1 = failed, 0 = none/in flight. Written by
        // the warmup thread before it clears the busy flag.
        static std::atomic<int> fusedWarmupOutcome{0};
        // Path label reported last frame. Hoisted from the sticky-label block
        // below so the step-down overlap detection can read which path was on
        // air before the governor demoted.
        static std::string lastReportedPipelineMode;
        // Path-transition reset: invoked whenever the ACTIVE keyer path
        // changes between fused (fused_cadence counts as fused), async_lite
        // and off. Clears everything the previous path owned, so the new
        // path can never serve or report the old path's stale masks/metrics
        // (before this, a lite->fused step-up left the worker's last pair in
        // place and the async telemetry block kept reporting its unbounded
        // age). Metrics fields the new path does not own are parked at -1
        // (counters at 0) until it writes them. Governor learning
        // (tier/backoffs) survives on purpose - it caused the transition.
        // preserveWorkerPair: set on a clean make-before-break cutover
        // (fused -> async_lite with the worker's first pair already
        // published). That pair IS the new path's first output — clearing it
        // would re-open the exact un-keyed gap the overlap just bridged, so
        // only the fused-side and telemetry state is reset then.
        const auto resetKeyerPathState = [&](bool preserveWorkerPair = false) {
          if (!preserveWorkerPair) {
            keyerWorker.clear();
          }
          maskAgeAverage.clear();
          asyncMaskRetention.reset();
          fusedCadence.reset();
          lastFusedRawMask = AlphaMask{};
          lastFusedInferredTsNs = 0u;
          lastFusedInferredLuma = LumaThumb{};
          lastFusedPublishedMask = AlphaMask{};
          fusedSubjectPresenceTracker().reset();
          fusedStabilizerState().reset();
          std::lock_guard<std::mutex> lock(state.mutex);
          state.keyerMetrics.keyerPublishToProgramMs = -1.0;
          state.keyerMetrics.maskAgeAvgMs = -1.0;
          state.keyerMetrics.keyerFps = -1.0;
          state.keyerMetrics.keyerProcessingMs = -1.0;
          state.keyerMetrics.keyerInputAgeMs = -1.0;
          state.keyerMetrics.droppedFramesPerSec = -1.0;
          state.keyerMetrics.droppedFrames = 0u;
          state.keyerMetrics.skippedFrames = 0u;
        };
        std::string fusedPipelineModeLabel;
        // Effective performance mode driving the keyer this frame (empty on
        // guard-skip frames; sticky in state like the pipeline label).
        std::string fusedActiveMode;
        // Set on the frame a step-down overlap cuts over with a fresh worker
        // pair: the path-transition reset below then keeps the worker state.
        bool preserveWorkerOnCutover = false;
        if (gpuPipelineEnabled() && fusedKeyerWorkDue && hasCameraFrame && snapshot.keyerEnabled &&
            !latestCameraFrame.rgba.empty()) {
          // Synchronous keyer on the CURRENT frame -> mask age 0. The raw
          // MODNet matte carries no refine, so snap its edge onto the current
          // frame with the same GPU guided filter the live-snap path uses (CPU
          // guided as fallback). The async worker self-parks (submit guard above),
          // so this dedicated instance is the only live inference session.
          // Backend via the matting factory (DirectML MODNet, or OpenVINO on
          // Intel GPU/NPU when compiled in) - the SAME factory as KeyerChain's
          // async keyer, so both sites always run the same backend.
          static const std::unique_ptr<MattingKeyer> fusedKeyer =
              createMattingKeyer(makeMattingBackendOptionsFromEnv(options.modelsDir));
          const auto fusedNow = std::chrono::steady_clock::now();
          const bool governorAutoEnabled = autoDegradeEnabled();
          if (governorAutoEnabled) {
            fusedGovernor.maybeStepUp(fusedNow);
            // Seed once from the session-build warmup probe (median steady
            // inference cost at the 512 shape); available after the first
            // apply() loaded the session, so seeding lands one frame later.
            // Skipped while a warm-handover warmup is in flight: status()
            // takes the keyer mutex the warmup thread holds for the whole
            // session build — polling it here would block the program loop
            // for exactly the stall the warm handover exists to avoid.
            // fusedWarmupBusy — not the handover phase — is the true "the
            // warmup thread may still hold the keyer mutex" signal: a keyer
            // disable during warmup resets the handover to Idle (and the
            // governor, un-seeding it) while the thread keeps building the
            // session, so the phase check alone is not airtight.
            if (!fusedGovernor.seeded() &&
                fusedHandover.phase() != TierHandover::Phase::Warming &&
                !fusedWarmupBusy.load(std::memory_order_acquire)) {
              const KeyerStatus keyerStatus = fusedKeyer->status();
              if (keyerStatus.probeInferenceMs256 > 0.0) {
                fusedGovernor.seedMeasuredProbes(
                    keyerStatus.probeInferenceMs512,
                    keyerStatus.probeInferenceMs320,
                    keyerStatus.probeInferenceMs256);
              } else if (keyerStatus.probeInferenceMs > 0.0) {
                fusedGovernor.seedProbe(keyerStatus.probeInferenceMs);
              }
            }
            // The governor drives the fused input resolution; the env
            // performance pin (A/B testing) wins. ModnetKeyer rebuilds its
            // DML session safely on a size change.
            if (!fusedKeyerPerformanceOverrideActive()) {
              keyerSettings.performanceMode = fusedGovernor.performanceModeForTier();
            }
          }
          // Warm-handover step-up management (make-before-break): poll the
          // one-shot warmup thread, commit/cancel the governor's deferred
          // Lite -> fused step-up, and start a new warmup when the governor
          // approved one. While warming, the tier stays Lite256 and the async
          // worker stays on air untouched.
          if (governorAutoEnabled && warmHandoverEnabled()) {
            if (!fusedWarmupBusy.load(std::memory_order_acquire) &&
                fusedWarmupThread.joinable()) {
              // The thread body finished (busy is cleared last): join returns
              // immediately and the outcome is stable.
              fusedWarmupThread.join();
              if (fusedHandover.phase() == TierHandover::Phase::Warming) {
                fusedHandover.completeWarmup(
                    fusedWarmupOutcome.load(std::memory_order_relaxed) == 1);
              }
              fusedWarmupOutcome.store(0, std::memory_order_relaxed);
            }
            if (fusedHandover.consumeWarmupSuccess()) {
              // Perform the existing transition on the program thread: the
              // tier commit routes this very frame into the fused branch,
              // whose apply() now finds a warm session; the label change then
              // triggers the standard path-transition reset below.
              fusedGovernor.commitLiteStepUp(fusedNow);
            } else if (fusedHandover.consumeWarmupFailure()) {
              // Treat like a wrong estimate: step-up holdoff doubling + dwell
              // restart (the governor's existing backoff semantics).
              fusedGovernor.cancelLiteStepUp(fusedNow);
            }
            if (fusedGovernor.liteStepUpPending() &&
                fusedHandover.phase() == TierHandover::Phase::Idle &&
                !fusedWarmupBusy.load(std::memory_order_acquire) &&
                !fusedWarmupThread.joinable()) {
              // Warm the mode the fused tier will actually run: after a Lite
              // step-up the governor drives "performance"; an env performance
              // pin wins (the governor does not drive the mode then). The
              // fused keyer instance is idle in the Lite tier (apply() only
              // runs in the fused branch below), so the warmup thread has the
              // instance to itself under the keyer's internal mutex.
              const std::string warmupMode =
                  fusedKeyerPerformanceOverrideActive()
                      ? keyerSettings.performanceMode
                      : std::string("performance");
              fusedHandover.beginWarmup(fusedNow);
              fusedWarmupOutcome.store(0, std::memory_order_relaxed);
              fusedWarmupBusy.store(true, std::memory_order_release);
              MattingKeyer *const keyerForWarmup = fusedKeyer.get();
              try {
                fusedWarmupThread =
                    std::thread([keyerForWarmup, warmupMode]() {
                      bool warmupOk = false;
                      try {
                        warmupOk =
                            keyerForWarmup->warmupForPerformanceMode(warmupMode);
                      } catch (...) {
                        warmupOk = false;
                      }
                      fusedWarmupOutcome.store(warmupOk ? 1 : -1,
                                               std::memory_order_relaxed);
                      // MUST stay the last statement: the program thread only
                      // joins after observing busy == false.
                      fusedWarmupBusy.store(false, std::memory_order_release);
                    });
              } catch (...) {
                // Thread creation failed: treat as a failed warmup (the
                // wrong-estimate path fires on the next frame).
                fusedWarmupBusy.store(false, std::memory_order_release);
                fusedHandover.completeWarmup(false);
              }
            }
          }
          // The busy flag — not the handover phase — signals "the warmup
          // thread may still hold the fused keyer's mutex": a keyer disable
          // during an in-flight warmup resets the handover to Idle (and the
          // governor entirely) while the session build keeps running for up
          // to ~12 s. While set, any status()/apply() on the fused keyer
          // could block the program loop for the rest of that build, so the
          // frame is served exactly like a Warming frame below: async path
          // on air, no fused keyer calls. Read AFTER the join-poll above, so
          // a finished thread is reclaimed (and the flag observed cleared)
          // on this very frame.
          const bool fusedWarmupInFlight =
              fusedWarmupBusy.load(std::memory_order_acquire);
          // While the governor parks the keyer in async-lite, pin the fast
          // profile on the worker's chain: at ~11 reused masks/s the mask AGE
          // dominates perceived ghosting, so the younger 256-class mask beats
          // the finer 320 one. Cleared automatically outside the lite tier.
          keyerWorker.setGovernorPerformanceFloor(
              governorAutoEnabled && fusedGovernor.wantsAsyncLite());
          // What actually drives the keyer now: the governor's tier (which is
          // also the async-lite floor, "performance"), or the webapp mode
          // when auto-degradation is off / the env pin is active.
          fusedActiveMode = keyerSettings.performanceMode;
          if (governorAutoEnabled && fusedGovernor.wantsOff()) {
            // Even async 256 inference is uselessly slow on this machine:
            // stop keying entirely and say so. The async worker is starved
            // (g_fusedKeyerDegraded stays false -> submit guard blocks) and
            // cleared like the keyer-disabled path, so no stale mask lingers.
            g_fusedKeyerDegraded = false;
            // A Lite -> Off step-down aborts any step-down overlap in flight
            // (a Warming phase is left to the poll block above; its outcome
            // commits as a no-op because the step-down cleared the pending
            // step-up in the governor).
            if (fusedHandover.phase() == TierHandover::Phase::Overlap) {
              fusedHandover.finishOverlap();
            }
            selectedPair.reset();
            frameForCompositor = &latestCameraFrame;
            const GovernorOffCompositorInput offInput =
                selectGovernorOffCompositorInput(!lastFusedRawMask.alpha.empty());
            if (offInput == GovernorOffCompositorInput::LastMask) {
              fusedMask = lastFusedRawMask;
              if (!(d3d11GuidedRefineAvailable() &&
                    guidedRefineMaskD3D11(fusedMask, latestCameraFrame))) {
                guidedRefineMask(fusedMask, latestCameraFrame);
              }
              fusedMask.timestampNs = latestCameraFrame.timestampNs;
            } else {
              fusedMask.width = latestCameraFrame.width;
              fusedMask.height = latestCameraFrame.height;
              fusedMask.timestampNs = latestCameraFrame.timestampNs;
              fusedMask.alpha.assign(
                  static_cast<size_t>(fusedMask.width) * fusedMask.height, 0u);
              fusedMask.emptyValid = true;
            }
            maskForCompositor = &fusedMask;
            KeyerStatus offStatus;
            offStatus.activeKeyer = "modnet";
            offStatus.backend = "modnet";
            offStatus.qualityMode = keyerSettings.qualityMode;
            offStatus.fallbackActive = true;
            offStatus.fallbackReason = "gpu_too_slow";
            updateMeetingKeyerStatus(state, offStatus);
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              state.keyerDegraded = true;
              state.degradationStage =
                  fusedMask.emptyValid ? "background_only" : "keyer_off_hold";
              state.staleMaskActive = !fusedMask.emptyValid;
            }
            fusedPipelineModeLabel = fusedGovernor.pipelineModeLabel(false);
          } else if (governorAutoEnabled && fusedGovernor.wantsAsyncLite()) {
            // Fused inference cannot hold frame rate even at 256: hand the
            // keyer to the async worker (mask reuse keeps the program at
            // frame rate) via the existing degradation mechanism. The flag
            // clears automatically once an estimate-based step-up leaves the
            // tier and the fused path runs (and succeeds) again.
            g_fusedKeyerDegraded = true;
            // Feed the async worker's measured inference cost into the
            // governor: the Lite256 EMA is what the estimate-based step-up
            // (and the Lite -> Off guard) judges — the LIVE cost under GPU
            // contention, not the isolated benchmark. One sample per
            // published pair (deduped by the monotonic publish stamp). The
            // cost travels ON the pair: reading state.inferenceMs here could
            // pair a fresh publish stamp with a stale pre-demotion value,
            // because the worker publishes the pair before it writes the
            // matching status.
            static uint64_t lastAsyncSampledPublishNs = 0u;
            uint64_t latestLitePublishNs = 0u;
            if (const std::shared_ptr<const PairedKeyerFrame> litePair =
                    keyerWorker.copyLatest()) {
              latestLitePublishNs = litePair->publishedAtNs;
              if (litePair->publishedAtNs != 0u &&
                  litePair->publishedAtNs != lastAsyncSampledPublishNs) {
                lastAsyncSampledPublishNs = litePair->publishedAtNs;
                if (litePair->inferenceMs > 0.0) {
                  fusedGovernor.addSample(litePair->inferenceMs, fusedNow);
                }
              }
            }
            // Make-before-break step-down: on the first async-lite frame
            // after a fused epoch, keep the fused keyer ON AIR until the
            // worker publishes its first pair (bounded overlap), then cut
            // over. Overlap frames keep reporting "fused" — honest (fused is
            // what composites) and it defers the sticky path-transition
            // reset below to the exact cutover frame.
            // !fusedWarmupInFlight: never start a bridge whose apply() could
            // block on the keyer mutex a leftover warmup thread holds
            // (unreachable by construction today — busy implies the fused
            // path did not run last frame — but kept airtight).
            if (warmHandoverEnabled() && !fusedWarmupInFlight &&
                fusedHandover.phase() == TierHandover::Phase::Idle &&
                canonicalKeyerPathLabel(lastReportedPipelineMode) == "fused") {
              fusedHandover.beginOverlap(nowNs(), fusedNow);
            }
            bool overlapBridgesThisFrame = false;
            if (fusedHandover.phase() == TierHandover::Phase::Overlap) {
              if (fusedHandover.cutoverDue(latestLitePublishNs, fusedNow)) {
                // Cut over now. A fresh pair means the worker state is the
                // NEW path's first output and must survive the transition
                // reset; the timeout path keeps today's full reset.
                preserveWorkerOnCutover =
                    fusedHandover.pairArrivedSinceOverlapStart(
                        latestLitePublishNs);
                fusedHandover.finishOverlap();
              } else {
                overlapBridgesThisFrame = true;
              }
            }
            if (overlapBridgesThisFrame) {
              // Same chain as the fused branch (EMA stabilize -> guided
              // refine -> postprocess parity) while the async worker warms up
              // in parallel; g_fusedKeyerDegraded stays true so the worker
              // keeps receiving frames. The inference cost is NOT fed to the
              // governor: the Lite EMA must track the ASYNC worker's cost
              // (basis of the next step-up estimate), not the known-over-
              // budget fused cost that caused this demotion. The tier is
              // Lite256, so keyerSettings.performanceMode is "performance" =
              // the same 256 input the demoted fused tier ran -> apply()
              // never rebuilds the session here.
              KeyerResult fused =
                  fusedKeyer->apply(latestCameraFrame, keyerSettings);
              if (!fused.status.fallbackActive && !fused.mask.alpha.empty()) {
                fusedMask = std::move(fused.mask);
                stabilizeFusedMask(fusedMask, fusedSmootherEmaEnabled());
                if (!(d3d11GuidedRefineAvailable() &&
                      guidedRefineMaskD3D11(fusedMask, latestCameraFrame))) {
                  guidedRefineMask(fusedMask, latestCameraFrame);
                }
                if (fusedPostprocessEnabled() && !fusedMask.emptyValid) {
                  postprocessAlpha(fusedMask, lastFusedPublishedMask,
                                   keyerSettings, 0.0, fused.status.metrics);
                  lastFusedPublishedMask = fusedMask;
                }
                frameForCompositor = &latestCameraFrame;
                maskForCompositor = &fusedMask;
                shouldRenderProgram = true;
                updateMeetingKeyerStatus(state, fused.status);
                fusedPipelineModeLabel = "fused";
                std::lock_guard<std::mutex> lock(state.mutex);
                state.keyerMetrics.maskAgeMs = 0.0;
                state.keyerMetrics.maskAgeAvgMs = 0.0;
                state.keyerMetrics.keyerPublishToProgramMs = -1.0;
                // Async-owned rate: park it while fused bridges the overlap.
                // The async telemetry blocks are muted during Overlap (see
                // g_fusedStepDownOverlapActive), so nothing else keeps this
                // honest — a stale near-zero fps next to stage "fused" is
                // exactly the mixed sample this guards against.
                state.keyerMetrics.keyerFps = -1.0;
                state.degradationStage =
                    fusedMask.emptyValid ? "no_subject" : "fused";
                state.staleMaskActive = false;
              } else {
                // The fused keyer cannot bridge the overlap (inference
                // failed): cut over immediately — today's behavior — and let
                // the async block's output stand.
                fusedHandover.finishOverlap();
                updateMeetingKeyerStatus(state, fused.status);
                fusedPipelineModeLabel =
                    fusedGovernor.pipelineModeLabel(false);
              }
            } else {
              fusedPipelineModeLabel = fusedGovernor.pipelineModeLabel(false);
            }
          } else if (fusedWarmupInFlight) {
            // Fused-branch entry gate (see fusedWarmupInFlight above): the
            // governor no longer wants async-lite (typically: it was reset by
            // a keyer disable while a warmup was in flight), but the first
            // fused apply() would block on the keyer mutex the leftover
            // warmup thread may still hold. Serve like a Warming frame: the
            // async worker stays on air (degraded flag keeps feeding it) and
            // the label reports the path that actually composites. No
            // governor samples are fed here — the freshly reset governor
            // must keep its probe seeding (addSample would permanently
            // disable seedProbe). Clears itself: the join-poll above reclaims
            // the thread the frame after its body finishes.
            g_fusedKeyerDegraded = true;
            fusedPipelineModeLabel = "async_lite";
          } else {
            downsampleLumaThumb(latestCameraFrame.rgba.data(),
                                latestCameraFrame.width,
                                latestCameraFrame.height, currentFrameLuma);
            const bool hasValidRetainedMask =
                lastFusedInferredTsNs != 0u && !lastFusedRawMask.alpha.empty();
            const double motionScore =
                hasValidRetainedMask && lastFusedInferredLuma.valid()
                    ? meanAbsLumaDiff(currentFrameLuma, lastFusedInferredLuma)
                    : 0.0;
            CadenceDecision cadenceDecision = fusedCadence.decide(
                latestCameraFrame.timestampNs, motionScore,
                hasValidRetainedMask, fusedNow);
            if (!fusedPipelineDepthEnabled()) {
              cadenceDecision.runInference = true;
              cadenceDecision.maskAgeMs = 0.0;
            }
            if (cadenceDecision.runInference) {
              KeyerResult fused = fusedKeyer->apply(latestCameraFrame, keyerSettings);
              if (!fused.status.fallbackActive && !fused.mask.alpha.empty()) {
                g_fusedKeyerDegraded = false;
                fusedMask = std::move(fused.mask);
                // Temporal stabilization FIRST, on the raw matte: the motion-adaptive
                // EMA smooths the per-frame confidence jitter and the collapse guard
                // holds through MODNet dropouts (no "person briefly gone"). The guided
                // refine BELOW then re-snaps the edge to the CURRENT frame, so the EMA
                // never softens the visible boundary -> stable body AND crisp edge
                // (mirrors the async worker's EMA -> live-snap order).
                stabilizeFusedMask(fusedMask, fusedSmootherEmaEnabled());
                // Retain the stabilized matte BEFORE the guided refine ties
                // its edge to this specific frame; cadence-reused frames
                // re-run the refine against their own (current) frame.
                lastFusedRawMask = fusedMask;
                lastFusedInferredTsNs = latestCameraFrame.timestampNs;
                lastFusedInferredLuma = currentFrameLuma;
                // Edge glue LAST: re-align the EMA-stabilized matte's edge to the
                // CURRENT frame so the visible boundary stays crisp on motion.
                if (!(d3d11GuidedRefineAvailable() &&
                      guidedRefineMaskD3D11(fusedMask, latestCameraFrame))) {
                  guidedRefineMask(fusedMask, latestCameraFrame);
                }
                // Postprocess parity with the async worker: apply the
                // user-facing erode/dilate/feather/edge-stabilization chain
                // to the fused matte too (it was silently ignored here).
                // Runs at the guided-refine working resolution (512x288,
                // ~1-3 ms, fits the 33.3 ms grid at fused@256). maskAgeMs=0:
                // this matte was inferred from the CURRENT frame. Skipped
                // for confirmed-empty mattes (nothing to shape).
                if (fusedPostprocessEnabled() && !fusedMask.emptyValid) {
                  postprocessAlpha(fusedMask, lastFusedPublishedMask,
                                   keyerSettings, 0.0, fused.status.metrics);
                  lastFusedPublishedMask = fusedMask;
                }
                frameForCompositor = &latestCameraFrame;
                maskForCompositor = &fusedMask;
                shouldRenderProgram = true;
                updateMeetingKeyerStatus(state, fused.status);
                if (governorAutoEnabled) {
                  fusedGovernor.addSample(fused.status.inferenceMs, fusedNow);
                }
                fusedCadence.onInferenceCompleted(
                    latestCameraFrame.timestampNs, fused.status.inferenceMs,
                    fusedNow);
                fusedPipelineModeLabel =
                    fusedCadence.currentN() > 1 ? "fused_cadence" : "fused";
                std::lock_guard<std::mutex> lock(state.mutex);
                state.keyerMetrics.maskAgeMs = 0.0;
                state.keyerMetrics.maskAgeAvgMs = 0.0;
                // The fused path owns this field and has no publish hop;
                // never let the preserved-merge carry the async value.
                state.keyerMetrics.keyerPublishToProgramMs = -1.0;
                state.degradationStage =
                    fusedMask.emptyValid ? "no_subject" : "fused";
                state.staleMaskActive = false;
              } else {
                // Publish the failure instead of freezing silently (K-03): the
                // status stream now reports fallback_active + reason, and the async
                // fallback path starts receiving frames (submit guard above).
                g_fusedKeyerDegraded = true;
                updateMeetingKeyerStatus(state, fused.status);
                // The async fallback is the active source until a retry
                // succeeds - report that instead of blanking the pipeline
                // mode to null.
                fusedPipelineModeLabel = "async_lite";
              }
            } else {
              // Cadence skip: reuse the retained raw matte, but still run the
              // per-frame guided refine so the visible edge is snapped to the
              // CURRENT frame. Booked honestly: the mask body is
              // maskAgeMs old ("fused_reused"), only the edge is fresh.
              fusedMask = lastFusedRawMask;
              if (!(d3d11GuidedRefineAvailable() &&
                    guidedRefineMaskD3D11(fusedMask, latestCameraFrame))) {
                guidedRefineMask(fusedMask, latestCameraFrame);
              }
              // The GPU compositors cache mask uploads by timestampNs; the
              // refined mask belongs to the CURRENT frame now (KEY-02).
              fusedMask.timestampNs = latestCameraFrame.timestampNs;
              // Postprocess parity on reused frames too, with the HONEST
              // mask age: dynamic dilation widens and the edge stabilization
              // age-fades exactly like the async path would for a mask this
              // old. Runs after the timestamp rebase so the temporal chain
              // sees monotonic stamps.
              KeyerMetrics reusedPostprocessMetrics;
              if (fusedPostprocessEnabled() && !fusedMask.emptyValid) {
                postprocessAlpha(fusedMask, lastFusedPublishedMask,
                                 keyerSettings, cadenceDecision.maskAgeMs,
                                 reusedPostprocessMetrics);
                lastFusedPublishedMask = fusedMask;
              }
              frameForCompositor = &latestCameraFrame;
              maskForCompositor = &fusedMask;
              shouldRenderProgram = true;
              fusedPipelineModeLabel =
                  fusedCadence.currentN() > 1 ? "fused_cadence" : "fused";
              std::lock_guard<std::mutex> lock(state.mutex);
              state.keyerMetrics.maskAgeMs = cadenceDecision.maskAgeMs;
              // Owned by the fused path (see the inference branch).
              state.keyerMetrics.keyerPublishToProgramMs = -1.0;
              if (fusedPostprocessEnabled() && !fusedMask.emptyValid) {
                state.keyerMetrics.maskPostprocessMs =
                    reusedPostprocessMetrics.maskPostprocessMs;
              }
              state.degradationStage =
                  fusedMask.emptyValid ? "no_subject" : "fused_reused";
              state.staleMaskActive = !fusedMask.emptyValid &&
                                      cadenceDecision.maskAgeMs >=
                                          keyerSettings.degradation.freshMaskAgeMs;
            }
          }
        } else if (!snapshot.keyerEnabled) {
          // User disabled the keyer: forget the learned degradation state so
          // a re-enable starts from a clean probe (spec'd reset point). Not
          // reset on camera hiccups - those must not wipe governor learning.
          fusedGovernor.reset();
          fusedCadence.reset();
          lastFusedRawMask = AlphaMask{};
          lastFusedInferredTsNs = 0u;
          lastFusedInferredLuma = LumaThumb{};
          lastFusedPublishedMask = AlphaMask{};
          fusedSubjectPresenceTracker().reset();
          fusedStabilizerState().reset();
          // Warm-handover cleanup: abort any transition; join the warmup
          // thread only when its body already finished (join is immediate
          // then). A still-running session build is left to complete in the
          // background — joining it here would block the program loop for
          // seconds; the busy flag keeps guarding single-flight reuse and
          // its late outcome is discarded (governor reset cleared pending).
          fusedHandover.reset();
          if (!fusedWarmupBusy.load(std::memory_order_acquire) &&
              fusedWarmupThread.joinable()) {
            fusedWarmupThread.join();
            fusedWarmupOutcome.store(0, std::memory_order_relaxed);
          }
        }
        // The reported pipeline mode must never blank while the section is
        // active: the guard can skip on camera hiccups (and the failure
        // branch used to leave it empty), which flapped keyer_pipeline_mode
        // to null mid-session. Keep the last reported mode sticky instead;
        // a disabled keyer genuinely clears it (null = not reported).
        // (lastReportedPipelineMode is declared with the fused statics above
        // — the step-down overlap detection reads it.)
        if (fusedPipelineModeLabel.empty() && snapshot.keyerEnabled) {
          fusedPipelineModeLabel = lastReportedPipelineMode;
        }
        if (!snapshot.keyerEnabled) {
          lastReportedPipelineMode.clear();
        } else if (!fusedPipelineModeLabel.empty()) {
          const bool pathChanged =
              !lastReportedPipelineMode.empty() &&
              canonicalKeyerPathLabel(fusedPipelineModeLabel) !=
                  canonicalKeyerPathLabel(lastReportedPipelineMode);
          if (pathChanged) {
            resetKeyerPathState(preserveWorkerOnCutover);
          }
          lastReportedPipelineMode = fusedPipelineModeLabel;
        }
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.keyerPipelineMode = fusedPipelineModeLabel;
          if (!snapshot.keyerEnabled) {
            state.activePerformanceMode.clear();
          } else if (!fusedActiveMode.empty()) {
            state.activePerformanceMode = fusedActiveMode;
          }
        }
        // Mirror the overlap phase for the async telemetry blocks: they run
        // BEFORE this section in the next loop iteration and cannot see the
        // static fusedHandover, so they read the previous frame's phase via
        // this flag and mute their telemetry writes while it is set.
        g_fusedStepDownOverlapActive =
            fusedHandover.phase() == TierHandover::Phase::Overlap;
      }
#else
      (void)fusedMask;
#endif  // __APPLE__

      if (shouldRenderProgram) {
        renderProgramFrame(
            options,
            snapshot,
            frameForCompositor,
            maskForCompositor,
            backGraphicsFrameForCompositor,
            frontGraphicsFrameForCompositor,
            (pipActive && !latestPipFrame.rgba.empty()) ? &latestPipFrame
                                                        : nullptr,
            frameIndex++,
            programFrame);
        if (selectedPair != nullptr) {
          lastUsedKeyerPublishedNs = selectedPair->publishedAtNs;
        }
        lastProgramRevision = runtime.programRevision;
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.programDirty = false;
          state.graphicsDirty = false;
          ++state.renderedFrames;
        }
      } else {
        std::lock_guard<std::mutex> lock(state.mutex);
        ++state.reusedFrames;
      }

      // Tap the composited program frame for recording. No-op unless a
      // recording is active; runs every tick so the file keeps a steady
      // timeline (and holds the last image) even during static periods.
      if (!programFrame.empty()) {
        recorder.appendVideoFrame(programFrame.data(), options.width,
                                  options.height);
      }

      shouldWriteFramebus = shouldWriteFramebusFrame(
          runtime.framebusRunning, !programFrame.empty(), shouldRenderProgram,
          staticHeartbeatDue);
      if (shouldWriteFramebus) {
        framebus_writer_write_rgba(
            writer,
            programFrame.data(),
            programFrame.size(),
            hasCameraFrame ? latestCameraFrame.timestampNs : nowNs());
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          ++state.writtenFramebusFrames;
        }
        lastStaticHeartbeatAt = programStart;
      }

      shouldPublishPreview = previewConsumerActive && shouldRenderProgram && !programFrame.empty();
      if (shouldPublishPreview) {
        previewFrames.publish(options.width, options.height, programFrame.data(), programFrame.size());
        std::lock_guard<std::mutex> lock(state.mutex);
        ++state.publishedPreviewFrames;
      }

      const auto programEnd = std::chrono::steady_clock::now();
      programRate.tick(programEnd);
      nextFrameAt += frameInterval;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.compositorBackend = lastCompositorBackend();
#if defined(_WIN32)
        state.compositorAdapter = d3d11CompositorAdapterStatus();
        state.keyerMetrics.cameraTextureUploads = d3d11CompositorCameraUploadCount();
#endif
        state.keyerMetrics.programFrameMs = elapsedMs(programStart, programEnd);
        state.keyerMetrics.cameraCopyMs = elapsedMs(cameraCopyStart, cameraCopyEnd);
        state.keyerMetrics.programFps = programRate.value(programEnd);
        state.keyerMetrics.programFrameIntervalMs = programFrameIntervalMs;
      }
    }
    const auto now = std::chrono::steady_clock::now();
#if defined(_WIN32)
    if (nextFrameAt > now + frameInterval) {
      nextFrameAt = now + frameInterval;
    }
    if (nextFrameAt > now) {
      if (runtime.cameraRunning) {
        if (camera.waitForFrameOrTimeout(lastCameraTimestampNs, nextFrameAt)) {
          nextFrameAt = std::chrono::steady_clock::now();
        }
      } else {
        std::this_thread::sleep_until(nextFrameAt);
      }
    } else {
      nextFrameAt = now;
    }
#else
    if (nextFrameAt > now) {
      if (runtime.cameraRunning) {
        camera.waitForFrameOrTimeout(lastCameraTimestampNs, nextFrameAt);
      } else {
        std::this_thread::sleep_until(nextFrameAt);
      }
    } else {
      nextFrameAt = now;
    }
#endif
  }
  framebus_writer_close(writer);
}

}  // namespace broadify::meeting
