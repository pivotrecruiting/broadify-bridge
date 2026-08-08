#pragma once

#include <cstdint>
#include <map>
#include <string>

namespace broadify::meeting {

// Decides whether a GraphicsFrameBusReader event may be logged.
//
// Motivation: when the graphics renderer parks its FrameBus at a fixed seq
// (only the init frame was written), the reader's 2s stale-reopen self-heal
// cycles stale_reopen -> closed -> opened -> frame_read forever. Every event
// differs from the previous one, so a simple (seq, event) dedup never
// latches and the helper log fills with an identical four-line block every
// two seconds.
//
// Policy (in precedence order):
//   (c) A seq regression or advance for an event name always logs.
//   (a) Once a reopen produced the same seq and geometry as observed before
//       the reopen (an idle no-op cycle), the whole cycle
//       (stale_reopen/closed/opened/frame_read) is suppressed until
//       something changes.
//   (b) Otherwise an identical event name without a seq change logs at most
//       once per 60s of wall-clock time.
//
// stdlib-only and clock-injected (nowNs parameter) for testability.
class FramebusReaderLogGate {
 public:
  // Returns true when the event should be written to the log. Call exactly
  // once per candidate event; allowed events update the internal bookkeeping.
  bool shouldLog(const std::string &event,
                 uint64_t seq,
                 uint32_t width,
                 uint32_t height,
                 uint64_t nowNs);

 private:
  struct LoggedEntry {
    uint64_t seq = 0;
    uint64_t ns = 0;
  };

  static constexpr uint64_t kRateLimitNs = 60'000'000'000ull;

  // Last logged seq / wall clock per event name, for rules (b) and (c).
  std::map<std::string, LoggedEntry> lastLogged_;
  // Observation captured at stale_reopen time, compared against the first
  // frame_read after the reopen to detect an idle no-op cycle (rule (a)).
  uint64_t preReopenSeq_ = 0;
  uint32_t preReopenWidth_ = 0;
  uint32_t preReopenHeight_ = 0;
  bool reopenPending_ = false;
  bool idleCycleSuppressed_ = false;
};

}  // namespace broadify::meeting
