#pragma once

#include <cstdint>

namespace broadify::meeting {

// Per-frame decision of the async/lite mask-age gate (Windows path).
enum class MaskRetentionDecision {
  // Age within the (adaptive) gate: apply the mask normally.
  Apply,
  // Over the gate but under the hard cap: KEEP applying the last mask (the
  // existing age-faded edge stabilization handles softening) instead of
  // flapping to an un-keyed frame. Surfaced as degradation_stage
  // "stale_hold".
  StaleHold,
  // Hard cap exceeded persistently: drop the mask and composite un-keyed
  // (frozen-mask protection), as the old hard-expiry path did.
  Passthrough,
};

struct MaskRetentionConfig {
  // The age gate adapts to the actual mask cadence: effective gate =
  // max(configured maxMaskAgeMs, retentionFactor * publish-interval EMA).
  // A healthy-but-slow keyer (e.g. masks every ~80ms under GPU contention)
  // then never oscillates around a fixed gate (field fix 2026-08-09).
  double retentionFactor = 2.5;
  // Absolute upper bound for holding a stale mask; also caps the adaptive
  // gate. Beyond this a mask is presumed frozen (worker stalled / person
  // left) and passthrough takes over.
  double hardCapMs = 1500.0;
  // EMA weight of the newest publish-interval sample.
  double intervalEmaWeight = 0.2;
  // Publish intervals above this are ignored for the EMA (worker restart,
  // keyer re-enable) so one outage cannot inflate the gate.
  double maxPlausibleIntervalMs = 5000.0;
  // Consecutive program frames the hard-cap condition must hold before
  // passthrough engages. Leaving passthrough is immediate on a fresh mask.
  uint32_t passthroughFrames = 5u;
};

// Pure, stdlib-only retention policy for the async keyer path: decides per
// program frame whether the latest published mask is applied, held although
// stale, or dropped. The caller (program loop) owns threading and feeds one
// observation per evaluation; a re-evaluation for the SAME camera frame (a
// fresher mask published mid-frame) does not advance the passthrough streak.
class MaskRetention {
 public:
  MaskRetention() = default;
  explicit MaskRetention(const MaskRetentionConfig &config);

  // frameTimestampNs: current camera frame (streak dedupe key).
  // maskPublishedAtNs: publish stamp of the evaluated mask pair (monotonic;
  // source of the publish-interval EMA and of the fresh-mask recovery).
  // maskAgeMs: age of that mask relative to the current camera frame.
  // configuredMaxAgeMs: the configured degradation.maxMaskAgeMs (>= 0).
  MaskRetentionDecision decide(uint64_t frameTimestampNs,
                               uint64_t maskPublishedAtNs,
                               double maskAgeMs,
                               double configuredMaxAgeMs,
                               bool workerAlive = true);

  // The adaptive gate currently in effect (capped at hardCapMs).
  double effectiveMaxAgeMs(double configuredMaxAgeMs) const;
  double intervalEmaMs() const { return intervalEmaMs_; }
  void reset();

 private:
  MaskRetentionConfig config_{};
  double intervalEmaMs_ = -1.0;
  uint64_t lastMaskPublishedAtNs_ = 0u;
  uint64_t lastFrameTimestampNs_ = 0u;
  uint32_t overCapFrames_ = 0u;
  bool passthroughActive_ = false;
};

}  // namespace broadify::meeting
