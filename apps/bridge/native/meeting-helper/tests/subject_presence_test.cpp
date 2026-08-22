#include "pipeline/subject_presence.h"

#include <iostream>

using broadify::meeting::SubjectPresence;
using broadify::meeting::SubjectPresenceConfig;
using broadify::meeting::SubjectPresenceTracker;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "subject_presence_test failed: " << what << std::endl;
  }
  return condition;
}

constexpr double kEmpty = 0.0005;    // clearly below the 0.002 floor
constexpr double kPresent = 0.05;    // clearly above the floor
constexpr double kAcceptAfterMs = 400.0;

}  // namespace

int main() {
  bool ok = true;

  {
    // Streak accumulation: successful empty frames confirm once the
    // accumulated time reaches the platform acceptAfterMs, never before.
    SubjectPresenceTracker tracker;
    double nowMs = 1000.0;
    ok &= expect(tracker.feed(kPresent, true, nowMs) == SubjectPresence::Present,
                 "confident coverage is Present");
    // First empty frame anchors the streak at zero accumulated time.
    nowMs += 33.3;
    ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                 "first empty frame bridges, never confirms");
    double accumulated = 0.0;
    bool confirmed = false;
    for (int frame = 0; frame < 80 && !confirmed; ++frame) {
      nowMs += 33.3;
      accumulated += 33.3;
      const SubjectPresence presence = tracker.feed(kEmpty, true, nowMs);
      if (accumulated < kAcceptAfterMs) {
        ok &= expect(presence == SubjectPresence::BridgingDropout,
                     "empty streak below acceptAfterMs stays BridgingDropout");
      } else {
        ok &= expect(presence == SubjectPresence::ConfirmedEmpty,
                     "empty streak at acceptAfterMs confirms");
        confirmed = true;
      }
    }
    ok &= expect(confirmed, "the streak eventually confirms");
  }

  {
    // Dropout vs empty: inference failures never advance the streak, no
    // matter how much wall time the failure gap spans.
    SubjectPresenceTracker tracker;
    double nowMs = 0.0;
    tracker.feed(kEmpty, true, nowMs);  // anchor the streak
    // A 10-second failure outage: would confirm 25x over if failures counted.
    for (int frame = 0; frame < 300; ++frame) {
      nowMs += 33.3;
      ok &= expect(tracker.feed(0.0, false, nowMs) != SubjectPresence::ConfirmedEmpty,
                   "a failed inference never confirms an empty frame");
    }
    // The first successful empty frame after the gap re-anchors: the gap
    // itself contributed zero time.
    nowMs += 33.3;
    ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                 "the failure gap added no streak time");
    // From here it still takes the full acceptAfterMs of successes.
    const int framesBeforeAccept =
        static_cast<int>(kAcceptAfterMs / 33.3) - 1;
    for (int frame = 0; frame < framesBeforeAccept; ++frame) {
      nowMs += 33.3;
      ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                   "post-gap accumulation restarts from the re-anchor");
    }
    nowMs += kAcceptAfterMs;
    ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::ConfirmedEmpty,
                 "post-gap successes confirm after the full acceptAfterMs");
  }

  {
    // Time-based acceptance independent of the call rate: a slow cadence
    // (5 fps) and a fast cadence (250 fps) confirm at the same wall time.
    SubjectPresenceTracker slow;
    double nowMs = 0.0;
    slow.feed(kEmpty, true, nowMs);
    SubjectPresence slowPresence = SubjectPresence::BridgingDropout;
    const int slowFrames = static_cast<int>(kAcceptAfterMs / 200.0) + 1;
    for (int frame = 0; frame < slowFrames; ++frame) {
      nowMs += 200.0;
      slowPresence = slow.feed(kEmpty, true, nowMs);
    }
    ok &= expect(slowPresence == SubjectPresence::ConfirmedEmpty,
                 "slow cadence confirms at 1500ms wall time");

    SubjectPresenceTracker fast;
    nowMs = 0.0;
    fast.feed(kEmpty, true, nowMs);
    const int fastFramesBeforeAccept =
        static_cast<int>(kAcceptAfterMs / 4.0) - 1;
    for (int frame = 0; frame < fastFramesBeforeAccept; ++frame) {
      nowMs += 4.0;
      ok &= expect(fast.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                   "fast cadence does not confirm before 1500ms wall time");
    }
    nowMs += 4.0;
    ok &= expect(fast.feed(kEmpty, true, nowMs) == SubjectPresence::ConfirmedEmpty,
                 "fast cadence confirms at 1500ms wall time");
  }

  {
    // Field scenario (Option A): 30 seconds of empty frames -> exactly one
    // transition into ConfirmedEmpty and no oscillation afterwards.
    SubjectPresenceTracker tracker;
    double nowMs = 0.0;
    int transitionsIntoConfirmed = 0;
    SubjectPresence previous = SubjectPresence::Present;
    for (int frame = 0; frame < 900; ++frame) {  // 30s at 30fps
      nowMs += 33.3;
      const SubjectPresence presence = tracker.feed(kEmpty, true, nowMs);
      if (presence == SubjectPresence::ConfirmedEmpty &&
          previous != SubjectPresence::ConfirmedEmpty) {
        ++transitionsIntoConfirmed;
      }
      if (previous == SubjectPresence::ConfirmedEmpty) {
        ok &= expect(presence == SubjectPresence::ConfirmedEmpty,
                     "confirmed absence never oscillates back while empty");
      }
      previous = presence;
    }
    ok &= expect(transitionsIntoConfirmed == 1,
                 "30s of empty frames confirm exactly once");

    // Re-entry: the first confident frame resets to Present within one feed,
    // and a following empty phase needs the full acceptance time again.
    nowMs += 33.3;
    ok &= expect(tracker.feed(kPresent, true, nowMs) == SubjectPresence::Present,
                 "re-entry accepts within one confident frame");
    nowMs += 33.3;
    ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                 "a new empty phase starts as a dropout again");
  }

  {
    // Kill-switch config (BROADIFY_MEETING_EMPTY_SUBJECT=0): an inert
    // tracker never confirms - the pre-Option-A behavior end-to-end.
    SubjectPresenceConfig inert;
    inert.enabled = false;
    SubjectPresenceTracker tracker(inert);
    double nowMs = 0.0;
    for (int frame = 0; frame < 900; ++frame) {  // 30s at 30fps
      nowMs += 33.3;
      ok &= expect(tracker.feed(kEmpty, true, nowMs) == SubjectPresence::BridgingDropout,
                   "inert tracker never confirms an empty frame");
    }
    nowMs += 33.3;
    ok &= expect(tracker.feed(kPresent, true, nowMs) == SubjectPresence::Present,
                 "inert tracker still classifies presence");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "subject_presence_test passed" << std::endl;
  return 0;
}
