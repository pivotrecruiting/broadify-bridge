// Covers the pure capture-format selector the macOS camera backend feeds with
// AVCaptureDevice.formats. Field finding (Nov 2026): an Elgato Cam Link 4K
// reports its 30 fps mode as the range 30.00003-30.00003, so the former exact
// `min <= target <= max` test never matched, nothing was configured and the
// device stayed at its 25 fps default (preview judder in a 30 fps stream).

#include "capture/capture_format_selection.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

using broadify::meeting::CaptureFormatCandidate;
using broadify::meeting::CaptureFormatMatch;
using broadify::meeting::CaptureFormatSelection;
using broadify::meeting::CaptureFormatTarget;
using broadify::meeting::captureFormatMatchName;
using broadify::meeting::kFpsTolerance;
using broadify::meeting::selectCaptureFormat;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "capture_format_selection_test failed: " << what << std::endl;
  }
  return condition;
}

bool near(double a, double b, double epsilon = 1e-9) {
  return std::fabs(a - b) <= epsilon;
}

CaptureFormatCandidate candidate(uint32_t width, uint32_t height,
                                 const char *pixelFormat,
                                 std::vector<std::pair<double, double>> ranges) {
  CaptureFormatCandidate out;
  out.width = width;
  out.height = height;
  out.pixelFormat = pixelFormat;
  for (const auto &range : ranges) {
    out.frameRateRanges.push_back({range.first, range.second});
  }
  return out;
}

// The Cam Link 4K ladder as AVFoundation reports it (every resolution lists
// the same four single-rate ranges).
std::vector<CaptureFormatCandidate> camLinkFormats() {
  const std::vector<std::pair<double, double>> rates{
      {25.0, 25.0},
      {30.00003000003, 30.00003000003},
      {50.0, 50.0},
      {60.00024000096, 60.00024000096},
  };
  return {
      candidate(640, 480, "420v", rates),
      candidate(1280, 720, "420v", rates),
      candidate(1920, 1080, "420v", rates),
      candidate(3840, 2160, "420v", rates),
  };
}

std::string describe(const CaptureFormatSelection &selection) {
  return std::string("index=") + std::to_string(selection.candidateIndex) +
         " range=" + std::to_string(selection.rangeIndex) +
         " fps=" + std::to_string(selection.fps) +
         " match=" + captureFormatMatchName(selection.match);
}

}  // namespace

int main() {
  bool ok = true;

  // Cam Link 4K: 30.00003 lies within the tolerance of the requested 30 and
  // the 1080p format is chosen with the device's own rate (not a synthetic 30).
  {
    const CaptureFormatSelection selection =
        selectCaptureFormat(camLinkFormats(), {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 2,
                 ("Cam Link picks 1920x1080: " + describe(selection)).c_str());
    ok &= expect(selection.rangeIndex == 1,
                 ("Cam Link picks the 30.00003 range: " + describe(selection)).c_str());
    ok &= expect(near(selection.fps, 30.00003000003),
                 ("Cam Link rate is the range's own 30.00003: " + describe(selection)).c_str());
    ok &= expect(selection.match == CaptureFormatMatch::Tolerant,
                 ("Cam Link match kind is tolerant: " + describe(selection)).c_str());
  }

  // A 720p request on the same ladder still lands on the device rate.
  {
    const CaptureFormatSelection selection =
        selectCaptureFormat(camLinkFormats(), {1280, 720, 30.0});
    ok &= expect(selection.candidateIndex == 1 && selection.rangeIndex == 1 &&
                     selection.match == CaptureFormatMatch::Tolerant,
                 ("Cam Link 720p request picks 1280x720 @ 30.00003 tolerant: " +
                  describe(selection))
                     .c_str());
  }

  // Exact 30.0 device: match kind exact, rate exactly the target.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1280, 720, "2vuy", {{30.0, 30.0}}),
        candidate(1920, 1080, "2vuy", {{30.0, 30.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1 && near(selection.fps, 30.0) &&
                     selection.match == CaptureFormatMatch::Exact,
                 ("exact 30 fps device reports exact: " + describe(selection)).c_str());
  }

  // FaceTime-like continuous range 1..30: the target is inside the range, so
  // the match is exact and the rate is the requested 30.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1280, 720, "420v", {{1.0, 30.0}}),
        candidate(1920, 1080, "420v", {{1.0, 30.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1 && selection.rangeIndex == 0 &&
                     near(selection.fps, 30.0) &&
                     selection.match == CaptureFormatMatch::Exact,
                 ("continuous 1-30 range matches 30 exactly: " + describe(selection)).c_str());
  }

  // 25/50-only device asked for 30: no tolerant match, nearest rate wins.
  // |25-30| = 5 beats |50-30| = 20, so 25 is chosen (not the higher 50).
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{25.0, 25.0}, {50.0, 50.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 0 && selection.rangeIndex == 0 &&
                     near(selection.fps, 25.0) &&
                     selection.match == CaptureFormatMatch::Nearest,
                 ("25/50 device asked for 30 gets nearest 25: " + describe(selection)).c_str());
  }

  // Tie rule for nearest: equal distance prefers the HIGHER rate
  // (24/36 asked for 30 -> 36).
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{24.0, 24.0}, {36.0, 36.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.rangeIndex == 1 && near(selection.fps, 36.0) &&
                     selection.match == CaptureFormatMatch::Nearest,
                 ("nearest tie prefers the higher rate: " + describe(selection)).c_str());
  }

  // 29.97 (NTSC) is a genuinely different rate: outside the tolerance, so it
  // is reported as nearest (and still chosen when it is the closest rate).
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{29.97, 29.97}, {59.94, 59.94}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(kFpsTolerance < 0.03, "tolerance stays below the 29.97/30 gap");
    ok &= expect(selection.rangeIndex == 0 && near(selection.fps, 29.97) &&
                     selection.match == CaptureFormatMatch::Nearest,
                 ("29.97 is nearest, not tolerant: " + describe(selection)).c_str());
  }

  // Nearest mode clamps into a continuous range: a 5..25 range asked for 30
  // yields 25 (the range end closest to the target).
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{5.0, 25.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(near(selection.fps, 25.0) &&
                     selection.match == CaptureFormatMatch::Nearest,
                 ("continuous range clamps to its nearest end: " + describe(selection)).c_str());
  }

  // Resolution scoring parity with the former inline rule: a format below the
  // target in either dimension carries a 1e6 penalty, so the nearest format
  // at-or-above the target wins even when a smaller one is closer in pixels.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1600, 900, "420v", {{30.0, 30.0}}),    // below target (penalty)
        candidate(2560, 1440, "420v", {{30.0, 30.0}}),   // above, delta 640+360
        candidate(3840, 2160, "420v", {{30.0, 30.0}}),   // above, delta 1920+1080
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1,
                 ("below-target penalty prefers the nearest format above: " +
                  describe(selection))
                     .c_str());
  }

  // Resolution scoring applies within the nearest tier too: among 25 fps
  // formats the 1080p one wins for a 1080p request.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1280, 720, "420v", {{25.0, 25.0}}),
        candidate(1920, 1080, "420v", {{25.0, 25.0}}),
        candidate(3840, 2160, "420v", {{25.0, 25.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1 &&
                     selection.match == CaptureFormatMatch::Nearest,
                 ("nearest tier still scores resolution: " + describe(selection)).c_str());
  }

  // Rate distance beats resolution in the nearest tier: a 720p@25 beats a
  // 1080p@15 for a 1080p30 request.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{15.0, 15.0}}),
        candidate(1280, 720, "420v", {{25.0, 25.0}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1 && near(selection.fps, 25.0),
                 ("nearest tier ranks rate distance before resolution: " +
                  describe(selection))
                     .c_str());
  }

  // Tolerant matches always beat nearest ones regardless of resolution.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(1920, 1080, "420v", {{25.0, 25.0}}),
        candidate(1280, 720, "420v", {{30.00003, 30.00003}}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == 1 &&
                     selection.match == CaptureFormatMatch::Tolerant,
                 ("tolerant match beats nearest regardless of size: " +
                  describe(selection))
                     .c_str());
  }

  // Degenerate candidates (zero dimensions, no ranges) are skipped; no usable
  // candidate at all reports none with no index.
  {
    const std::vector<CaptureFormatCandidate> formats{
        candidate(0, 0, "420v", {{30.0, 30.0}}),
        candidate(1920, 1080, "420v", {}),
    };
    const CaptureFormatSelection selection =
        selectCaptureFormat(formats, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == -1 &&
                     selection.match == CaptureFormatMatch::None,
                 ("degenerate candidates yield none: " + describe(selection)).c_str());
  }
  {
    const CaptureFormatSelection selection =
        selectCaptureFormat({}, {1920, 1080, 30.0});
    ok &= expect(selection.candidateIndex == -1 && selection.rangeIndex == -1 &&
                     selection.match == CaptureFormatMatch::None &&
                     selection.fps == 0.0,
                 ("no candidates yield none: " + describe(selection)).c_str());
  }

  // An invalid target (0 fps or 0 size) selects nothing, mirroring the former
  // early return.
  {
    const CaptureFormatSelection selection =
        selectCaptureFormat(camLinkFormats(), {1920, 1080, 0.0});
    ok &= expect(selection.match == CaptureFormatMatch::None,
                 ("zero target fps yields none: " + describe(selection)).c_str());
  }

  ok &= expect(std::string(captureFormatMatchName(CaptureFormatMatch::Exact)) == "exact" &&
                   std::string(captureFormatMatchName(CaptureFormatMatch::Tolerant)) == "tolerant" &&
                   std::string(captureFormatMatchName(CaptureFormatMatch::Nearest)) == "nearest" &&
                   std::string(captureFormatMatchName(CaptureFormatMatch::None)) == "none",
               "match names are the event tokens");

  if (!ok) {
    return 1;
  }
  std::cout << "capture_format_selection_test passed" << std::endl;
  return 0;
}
