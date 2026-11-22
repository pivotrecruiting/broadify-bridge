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
  HalfRate,  // half the requested rate, to keep the requested size
  Nearest,   // no range is close; the closest supported rate was chosen
  None,      // nothing usable (no candidates or an invalid target)
};

struct CaptureFormatSelection {
  int candidateIndex = -1;  // index into the candidate list, -1 for none
  int rangeIndex = -1;      // index into the chosen candidate's ranges
  double fps = 0.0;         // rate to configure (0 for none)
  CaptureFormatMatch match = CaptureFormatMatch::None;
};

// Picks the device format and frame rate for a capture request. Resolution
// wins over rate: a camera that delivers the requested size only at half the
// rate keeps the size, and the program shows each of its frames twice.
//
// "Containing" candidates have a range that contains a rate (exact) or
// contains it within kFpsTolerance (tolerant). They are ranked by resolution
// score: absolute width + height delta, plus a 1e6 penalty when either
// dimension is below the target. Exact beats tolerant on equal score.
//
// 1. Candidates not below the target size that contain the target rate.
// 2. Only above 30 fps (outputDivisor > 1): candidates not below the target
//    size that contain half the target rate (60 -> 30, 50 -> 25), reported as
//    half_rate. A clean 2:1 cadence in the program.
// 3. Candidates of any size that contain the target rate.
// 4. Without any of those, every candidate's closest supported rate (target
//    clamped into each range) competes: minimal |rate - target| wins, equal
//    distance prefers the higher rate, then the resolution score.
// 5. None only when no candidate has valid dimensions and at least one range
//    (or the target itself is invalid).
CaptureFormatSelection selectCaptureFormat(
    const std::vector<CaptureFormatCandidate> &candidates,
    const CaptureFormatTarget &target);

// Event and status token for the match kind ("exact", "tolerant",
// "half_rate", "nearest", "none").
const char *captureFormatMatchName(CaptureFormatMatch match);

}  // namespace broadify::meeting
