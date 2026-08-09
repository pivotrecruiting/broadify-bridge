#include "pipeline/framebus_reader_log_gate.h"

#include <cstdint>
#include <iostream>

using broadify::meeting::FramebusReaderLogGate;

namespace {

constexpr uint64_t kSecondNs = 1'000'000'000ull;

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "framebus_reader_log_gate_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  {
    // Idle-reattach cycle: after the first full cycle proved to be a no-op,
    // every subsequent cycle event is suppressed.
    FramebusReaderLogGate gate;
    uint64_t now = 0;
    ok &= expect(gate.shouldLog("opened", 0, 0, 0, now), "initial opened logs");
    ok &= expect(gate.shouldLog("frame_read", 1, 1280, 720, now), "initial frame_read logs");
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("stale_reopen", 1, 1280, 720, now), "first stale_reopen logs");
    ok &= expect(gate.shouldLog("closed", 1, 0, 0, now), "first closed logs");
    ok &= expect(!gate.shouldLog("opened", 0, 0, 0, now), "reopened with unchanged seq is deduped");
    ok &= expect(!gate.shouldLog("frame_read", 1, 1280, 720, now), "no-op frame_read is suppressed");
    for (int cycle = 0; cycle < 5; ++cycle) {
      now += 2 * kSecondNs;
      ok &= expect(!gate.shouldLog("stale_reopen", 1, 1280, 720, now), "idle stale_reopen suppressed");
      ok &= expect(!gate.shouldLog("closed", 1, 0, 0, now), "idle closed suppressed");
      ok &= expect(!gate.shouldLog("opened", 0, 0, 0, now), "idle opened suppressed");
      ok &= expect(!gate.shouldLog("frame_read", 1, 1280, 720, now), "idle frame_read suppressed");
    }
    // Idle suppression outlasts the 60s rate-limit window.
    now += 120 * kSecondNs;
    ok &= expect(!gate.shouldLog("stale_reopen", 1, 1280, 720, now), "idle cycle stays suppressed after 60s");
  }

  {
    // Seq advance always logs and ends the idle suppression.
    FramebusReaderLogGate gate;
    uint64_t now = 0;
    (void)gate.shouldLog("frame_read", 1, 1280, 720, now);
    (void)gate.shouldLog("stale_reopen", 1, 1280, 720, now);
    (void)gate.shouldLog("frame_read", 1, 1280, 720, now);  // suppression latched
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("frame_read", 2, 1280, 720, now), "seq advance logs");
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("stale_reopen", 2, 1280, 720, now),
                 "stale_reopen with advanced seq logs again");
    // Seq regression (writer recreated the segment) also logs.
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("frame_read", 1, 1280, 720, now), "seq regression logs");
  }

  {
    // Rate limit: identical event without a seq change logs at most once/60s.
    FramebusReaderLogGate gate;
    uint64_t now = 0;
    ok &= expect(gate.shouldLog("open_failed", 0, 0, 0, now), "first open_failed logs");
    now += 2 * kSecondNs;
    ok &= expect(!gate.shouldLog("open_failed", 0, 0, 0, now), "open_failed within 60s suppressed");
    now += 60 * kSecondNs;
    ok &= expect(gate.shouldLog("open_failed", 0, 0, 0, now), "open_failed after 60s logs again");
  }

  {
    // A reopen that yields a new geometry is progress, not an idle cycle.
    FramebusReaderLogGate gate;
    uint64_t now = 0;
    (void)gate.shouldLog("frame_read", 1, 1280, 720, now);
    (void)gate.shouldLog("stale_reopen", 1, 1280, 720, now);
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("frame_read", 5, 1920, 1080, now),
                 "post-reopen frame with new seq/geometry logs");
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("stale_reopen", 5, 1920, 1080, now),
                 "next stale_reopen after progress logs");
  }

  {
    // Failure events break the suppressed cycle so they are always visible.
    FramebusReaderLogGate gate;
    uint64_t now = 0;
    (void)gate.shouldLog("frame_read", 1, 1280, 720, now);
    (void)gate.shouldLog("stale_reopen", 1, 1280, 720, now);
    (void)gate.shouldLog("frame_read", 1, 1280, 720, now);  // suppression latched
    now += 2 * kSecondNs;
    ok &= expect(gate.shouldLog("copy_failed", 1, 1280, 720, now), "copy_failed logs during suppression");
    // With suppression broken, the cycle is only rate limited (once/60s)
    // instead of permanently silenced.
    now += 60 * kSecondNs;
    ok &= expect(gate.shouldLog("stale_reopen", 1, 1280, 720, now),
                 "cycle logs again after a failure broke suppression");
  }

  return ok ? 0 : 1;
}
