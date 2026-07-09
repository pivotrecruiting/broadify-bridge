#pragma once

#include <chrono>
#include <map>

namespace broadify::meeting {

// Conference "Auto-Regie": decides when the program feed should cut to a
// different camera based on the per-camera microphone levels. The decision is
// deliberately sluggish — a challenger camera must stay clearly the loudest for
// a sustained window before it wins, and the program is held for a minimum time
// after each cut. This keeps the output calm the way a human director would,
// instead of flicking on every cough.
//
// Not thread-safe: drive it from a single loop (the frame pipeline).
class AutoDirector {
 public:
  // A challenger must lead continuously for this long before it takes program.
  static constexpr std::chrono::milliseconds kDwell{900};
  // After a cut, hold the new program at least this long before cutting again.
  static constexpr std::chrono::milliseconds kMinHold{1500};
  // The loudest camera must beat the current program by this ratio to count as
  // "clearly louder" (unless the current program has gone quiet altogether).
  static constexpr float kLouderRatio = 1.4f;

  // Evaluates the current levels and returns the camera index the program
  // should cut to, or -1 to stay on the current program. `threshold` is the
  // minimum level (0..1) that counts as speech.
  int evaluate(const std::map<int, float> &levels, int currentProgram,
               float threshold,
               std::chrono::steady_clock::time_point now) {
    // Find the loudest camera.
    int loudest = -1;
    float loudestLevel = 0.0f;
    for (const auto &entry : levels) {
      if (entry.second > loudestLevel) {
        loudestLevel = entry.second;
        loudest = entry.first;
      }
    }

    // Nobody is speaking, or the loudest is already on program: hold.
    if (loudest < 0 || loudestLevel < threshold || loudest == currentProgram) {
      candidate_ = -1;
      return -1;
    }

    // Respect the minimum hold after a recent cut.
    if (now - lastSwitch_ < kMinHold) {
      return -1;
    }

    // The challenger must be clearly louder than the current program (or the
    // current program must have fallen below the speech threshold).
    const auto currentIt = levels.find(currentProgram);
    const float currentLevel =
        currentIt != levels.end() ? currentIt->second : 0.0f;
    const bool clearlyLouder =
        currentLevel < threshold || loudestLevel >= currentLevel * kLouderRatio;
    if (!clearlyLouder) {
      candidate_ = -1;
      return -1;
    }

    // The same challenger must persist for the dwell window before it wins.
    if (candidate_ != loudest) {
      candidate_ = loudest;
      candidateSince_ = now;
      return -1;
    }
    if (now - candidateSince_ < kDwell) {
      return -1;
    }

    lastSwitch_ = now;
    candidate_ = -1;
    return loudest;
  }

  // Forget any in-progress challenger (e.g. auto-director toggled off/on or the
  // camera set changed) without blocking the next switch on the hold window.
  void reset() { candidate_ = -1; }

 private:
  int candidate_ = -1;
  std::chrono::steady_clock::time_point candidateSince_{};
  std::chrono::steady_clock::time_point lastSwitch_{};
};

}  // namespace broadify::meeting
