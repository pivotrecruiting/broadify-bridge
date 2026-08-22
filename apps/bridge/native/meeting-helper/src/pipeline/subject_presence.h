#pragma once

namespace broadify::meeting {

// Classification of the keyer subject's presence, produced once per keyer
// inference result (fused path and async worker each own one tracker).
enum class SubjectPresence {
  // Confident foreground coverage: a person is in frame.
  Present,
  // Coverage collapsed but the empty streak is not confirmed yet (or the
  // tracker is disabled): treat it as a model dropout and hold the last
  // good mask, exactly like the existing collapse guards.
  BridgingDropout,
  // The subject verifiably left the frame: SUCCESSFUL inferences stayed
  // below the coverage floor for at least acceptAfterMs. Callers pass the
  // (empty) mask through flagged as valid, so the composited background
  // stays up instead of flapping to the raw camera (Option A).
  ConfirmedEmpty,
};

struct SubjectPresenceConfig {
  // Coverage floor: at or above this fraction of confident foreground pixels
  // the subject counts as present. Deliberately BELOW the pipeline's
  // kMinForegroundCoverage (0.006): the existing dropout guards keep judging
  // "essentially empty" unchanged, and only the truly-empty band can ever
  // confirm an absent subject.
#if defined(_WIN32)
  double emptyAcceptCoverage = 0.006;
#else
  double emptyAcceptCoverage = 0.003;
#endif
  // Accumulated time (across successful inferences only) the coverage must
  // stay below the floor before an empty frame is accepted. Time-based, so
  // the decision is independent of the inference cadence / call rate.
#if defined(_WIN32)
  double acceptAfterMs = 400.0;
#else
  double acceptAfterMs = 400.0;
#endif
  // Kill-switch hook (BROADIFY_MEETING_EMPTY_SUBJECT=0): an inert tracker
  // never confirms an empty frame -> exactly the pre-Option-A behavior.
  bool enabled = true;
};

// Pure, stdlib-only subject-presence policy. Time is injected (nowMs from
// any monotonic millisecond clock); the caller owns threading.
class SubjectPresenceTracker {
 public:
  SubjectPresenceTracker() = default;
  explicit SubjectPresenceTracker(const SubjectPresenceConfig &config);

  // One observation per keyer result. inferenceSucceeded=false (the keyer
  // produced no usable mask) never advances the empty streak: a model
  // dropout can bridge an arbitrary time without ever confirming an absent
  // subject (dropout protection stays intact).
  SubjectPresence feed(double coverage, bool inferenceSucceeded, double nowMs);

  void reset();

 private:
  SubjectPresenceConfig config_{};
  bool streakActive_ = false;
  // The accumulation anchor is dropped on inference failures, so the gap a
  // failure spans contributes zero time to the streak.
  bool hasAnchor_ = false;
  double anchorMs_ = 0.0;
  double accumulatedMs_ = 0.0;
  bool confirmed_ = false;
};

}  // namespace broadify::meeting
