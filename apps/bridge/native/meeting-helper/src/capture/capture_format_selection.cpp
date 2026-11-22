#include "capture/capture_format_selection.h"

#include "common/output_rate.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace broadify::meeting {

namespace {

// Resolution score of the former inline rule in camera_avfoundation.mm:
// absolute width/height distance, and a format below the target in either
// dimension is pushed behind every format at-or-above it.
bool belowTargetSize(const CaptureFormatCandidate &candidate,
                     const CaptureFormatTarget &target) {
  return candidate.width < target.width || candidate.height < target.height;
}

double resolutionScore(const CaptureFormatCandidate &candidate,
                       const CaptureFormatTarget &target) {
  const double widthDelta =
      std::fabs(static_cast<double>(candidate.width) - target.width);
  const double heightDelta =
      std::fabs(static_cast<double>(candidate.height) - target.height);
  return widthDelta + heightDelta +
         (belowTargetSize(candidate, target) ? 1000000.0 : 0.0);
}

bool usable(const CaptureFormatCandidate &candidate) {
  return candidate.width > 0u && candidate.height > 0u &&
         !candidate.frameRateRanges.empty();
}

struct RangeMatch {
  int rangeIndex = -1;
  double fps = 0.0;
  CaptureFormatMatch match = CaptureFormatMatch::None;
};

// Best range of one candidate for the target rate: exact beats tolerant; a
// tolerant hit returns the rate clamped into the range (30.00003 for a
// 30.00003-30.00003 range), never the synthetic target.
RangeMatch containingRange(const CaptureFormatCandidate &candidate,
                           double targetFps) {
  RangeMatch best;
  for (std::size_t index = 0; index < candidate.frameRateRanges.size(); ++index) {
    const CaptureFrameRateRange &range = candidate.frameRateRanges[index];
    if (range.minFps <= targetFps && targetFps <= range.maxFps) {
      return {static_cast<int>(index), targetFps, CaptureFormatMatch::Exact};
    }
    if (best.match == CaptureFormatMatch::None &&
        range.minFps - kFpsTolerance <= targetFps &&
        targetFps <= range.maxFps + kFpsTolerance) {
      best.rangeIndex = static_cast<int>(index);
      best.fps = std::clamp(targetFps, range.minFps, range.maxFps);
      best.match = CaptureFormatMatch::Tolerant;
    }
  }
  return best;
}

// Closest supported rate of one candidate (target clamped into each range):
// minimal distance, equal distance prefers the higher rate.
RangeMatch nearestRange(const CaptureFormatCandidate &candidate,
                        double targetFps) {
  RangeMatch best;
  double bestDistance = std::numeric_limits<double>::infinity();
  for (std::size_t index = 0; index < candidate.frameRateRanges.size(); ++index) {
    const CaptureFrameRateRange &range = candidate.frameRateRanges[index];
    if (range.maxFps <= 0.0 || range.minFps > range.maxFps) {
      continue;
    }
    const double rate = std::clamp(targetFps, range.minFps, range.maxFps);
    const double distance = std::fabs(rate - targetFps);
    if (distance < bestDistance ||
        (distance == bestDistance && rate > best.fps)) {
      bestDistance = distance;
      best.rangeIndex = static_cast<int>(index);
      best.fps = rate;
      best.match = CaptureFormatMatch::Nearest;
    }
  }
  return best;
}

enum class SizeRule {
  NotBelowTarget,  // only candidates at or above the target in both dimensions
  Any,
};

bool admitted(const CaptureFormatCandidate &candidate,
              const CaptureFormatTarget &target, SizeRule sizeRule) {
  return usable(candidate) && (sizeRule == SizeRule::Any ||
                               !belowTargetSize(candidate, target));
}

// Best candidate with a range that contains `fps` (exactly or within the
// tolerance), ranked by resolution score; exact wins equal scores. Match None
// when no candidate qualifies.
CaptureFormatSelection selectContaining(
    const std::vector<CaptureFormatCandidate> &candidates,
    const CaptureFormatTarget &target, double fps, SizeRule sizeRule) {
  CaptureFormatSelection selection;
  double bestScore = std::numeric_limits<double>::max();
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    const CaptureFormatCandidate &candidate = candidates[index];
    if (!admitted(candidate, target, sizeRule)) {
      continue;
    }
    const RangeMatch match = containingRange(candidate, fps);
    if (match.match == CaptureFormatMatch::None) {
      continue;
    }
    const double score = resolutionScore(candidate, target);
    const bool better =
        score < bestScore ||
        (score == bestScore && match.match == CaptureFormatMatch::Exact &&
         selection.match == CaptureFormatMatch::Tolerant);
    if (better) {
      bestScore = score;
      selection.candidateIndex = static_cast<int>(index);
      selection.rangeIndex = match.rangeIndex;
      selection.fps = match.fps;
      selection.match = match.match;
    }
  }
  return selection;
}

// Closest supported rate across the candidates the size rule admits (higher
// rate on equal distance), then the resolution score. Match None when no
// candidate qualifies.
CaptureFormatSelection selectNearest(
    const std::vector<CaptureFormatCandidate> &candidates,
    const CaptureFormatTarget &target, SizeRule sizeRule) {
  CaptureFormatSelection selection;
  double bestDistance = std::numeric_limits<double>::infinity();
  double bestScore = std::numeric_limits<double>::max();
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    const CaptureFormatCandidate &candidate = candidates[index];
    if (!admitted(candidate, target, sizeRule)) {
      continue;
    }
    const RangeMatch match = nearestRange(candidate, target.fps);
    if (match.match == CaptureFormatMatch::None) {
      continue;
    }
    const double distance = std::fabs(match.fps - target.fps);
    const double score = resolutionScore(candidate, target);
    const bool better =
        distance < bestDistance ||
        (distance == bestDistance &&
         (match.fps > selection.fps ||
          (match.fps == selection.fps && score < bestScore)));
    if (better) {
      bestDistance = distance;
      bestScore = score;
      selection.candidateIndex = static_cast<int>(index);
      selection.rangeIndex = match.rangeIndex;
      selection.fps = match.fps;
      selection.match = CaptureFormatMatch::Nearest;
    }
  }
  return selection;
}

}  // namespace

CaptureFormatSelection selectCaptureFormat(
    const std::vector<CaptureFormatCandidate> &candidates,
    const CaptureFormatTarget &target) {
  if (target.width == 0u || target.height == 0u || target.fps <= 0.0) {
    return {};
  }

  // Tier 1: the requested rate without giving up the requested size.
  CaptureFormatSelection selection = selectContaining(
      candidates, target, target.fps, SizeRule::NotBelowTarget);
  if (selection.match != CaptureFormatMatch::None) {
    return selection;
  }

  // Tier 2: above 30 fps, half the rate at the requested size beats the full
  // rate at a smaller one.
  if (outputDivisor(target.fps) > 1u) {
    selection = selectContaining(candidates, target,
                                 target.fps / outputDivisor(target.fps),
                                 SizeRule::NotBelowTarget);
    if (selection.match != CaptureFormatMatch::None) {
      selection.match = CaptureFormatMatch::HalfRate;
      return selection;
    }
  }

  // Tier 3: the requested rate at a smaller size.
  selection =
      selectContaining(candidates, target, target.fps, SizeRule::Any);
  if (selection.match != CaptureFormatMatch::None) {
    return selection;
  }

  // Tier 4: nothing is close to the target; take the closest supported rate.
  // Above 30 fps the candidates not below the requested size compete first,
  // so a 50 fps request on a 1080p30 + 720p60 camera keeps 1080p (30 fps)
  // instead of dropping to 720p60.
  if (outputDivisor(target.fps) > 1u) {
    selection = selectNearest(candidates, target, SizeRule::NotBelowTarget);
    if (selection.match != CaptureFormatMatch::None) {
      return selection;
    }
  }
  return selectNearest(candidates, target, SizeRule::Any);
}

const char *captureFormatMatchName(CaptureFormatMatch match) {
  switch (match) {
    case CaptureFormatMatch::Exact:
      return "exact";
    case CaptureFormatMatch::Tolerant:
      return "tolerant";
    case CaptureFormatMatch::HalfRate:
      return "half_rate";
    case CaptureFormatMatch::Nearest:
      return "nearest";
    case CaptureFormatMatch::None:
      break;
  }
  return "none";
}

}  // namespace broadify::meeting
