#include "pipeline/framebus_reader_log_gate.h"

namespace broadify::meeting {

bool FramebusReaderLogGate::shouldLog(const std::string &event,
                                      uint64_t seq,
                                      uint32_t width,
                                      uint32_t height,
                                      uint64_t nowNs) {
  const bool isCycleEvent = event == "stale_reopen" || event == "closed" ||
                            event == "opened" || event == "frame_read";

  // Track the idle-reattach cycle: stale_reopen records the pre-reopen
  // observation; the first frame_read after the reopen tells whether the
  // reopen made progress (new seq/geometry) or was a no-op.
  if (event == "stale_reopen") {
    preReopenSeq_ = seq;
    preReopenWidth_ = width;
    preReopenHeight_ = height;
    reopenPending_ = true;
  } else if (event == "frame_read" && reopenPending_) {
    reopenPending_ = false;
    idleCycleSuppressed_ = seq == preReopenSeq_ && width == preReopenWidth_ &&
                           height == preReopenHeight_;
  } else if (!isCycleEvent) {
    // Failures (open_failed/copy_failed/info_failed) end any suppressed
    // cycle; they must never be hidden behind it.
    reopenPending_ = false;
    idleCycleSuppressed_ = false;
  }

  const auto it = lastLogged_.find(event);
  const bool seqChanged = it == lastLogged_.end() || it->second.seq != seq;

  bool allow = false;
  if (seqChanged) {
    // (c) First sighting or a seq advance/regression always logs.
    allow = true;
    if (event == "frame_read") {
      // Real frame progress ends the idle suppression.
      idleCycleSuppressed_ = false;
    }
  } else if (idleCycleSuppressed_ && isCycleEvent) {
    // (a) A confirmed no-op reattach cycle is suppressed entirely.
    allow = false;
  } else {
    // (b) Identical event without a seq change: at most once per 60s.
    allow = nowNs - it->second.ns >= kRateLimitNs;
  }

  if (allow) {
    lastLogged_[event] = LoggedEntry{seq, nowNs};
  }
  return allow;
}

}  // namespace broadify::meeting
