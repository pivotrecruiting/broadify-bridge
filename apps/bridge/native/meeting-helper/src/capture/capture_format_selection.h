#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

// Frame rates within this distance of the requested rate count as the
// requested rate. Capture devices report their nominal modes with float
// noise (Elgato Cam Link 4K: 30.00003 for 30, 60.00024 for 60); genuinely
// different rates such as 29.97 stay outside the tolerance and go through the
// nearest-rate fallback instead.
constexpr double kFpsTolerance = 0.01;

struct CaptureFrameRateRange {
  double minFps = 0.0;
  double maxFps = 0.0;
};

// One device format as the platform backend reports it (AVCaptureDeviceFormat
// on macOS): dimensions, a pixel-format token for diagnostics and the
// supported frame-rate ranges.
struct CaptureFormatCandidate {
  uint32_t width = 0;
  uint32_t height = 0;
  std::string pixelFormat;
  std::vector<CaptureFrameRateRange> frameRateRanges;
};

struct CaptureFormatTarget {
  uint32_t width = 0;
  uint32_t height = 0;
  double fps = 0.0;
};

enum class CaptureFormatMatch {
  Exact,     // a range contains the requested rate
  Tolerant,  // a range contains it within kFpsTolerance
  Nearest,   // no range is close; the closest supported rate was chosen
  None,      // nothing usable (no candidates or an invalid target)
};

struct CaptureFormatSelection {
  int candidateIndex = -1;  // index into the candidate list, -1 for none
  int rangeIndex = -1;      // index into the chosen candidate's ranges
  double fps = 0.0;         // rate to configure (0 for none)
  CaptureFormatMatch match = CaptureFormatMatch::None;
};

// Picks the device format and frame rate for a capture request.
//
// 1. Candidates with a range that contains the target (exact) or contains it
//    within kFpsTolerance (tolerant) are ranked by resolution score: absolute
//    width + height delta, plus a 1e6 penalty when either dimension is below
//    the target. Exact beats tolerant on equal score.
// 2. Without such a candidate, every candidate's closest supported rate
//    (target clamped into each range) competes: minimal |rate - target|
//    wins, equal distance prefers the higher rate, then the resolution score.
// 3. None only when no candidate has valid dimensions and at least one range
//    (or the target itself is invalid).
CaptureFormatSelection selectCaptureFormat(
    const std::vector<CaptureFormatCandidate> &candidates,
    const CaptureFormatTarget &target);

// Event token for the match kind ("exact", "tolerant", "nearest", "none").
const char *captureFormatMatchName(CaptureFormatMatch match);

}  // namespace broadify::meeting
