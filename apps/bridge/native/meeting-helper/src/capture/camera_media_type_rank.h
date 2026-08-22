#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace broadify::meeting {

struct CameraMediaTypeRank {
  double fps = 0.0;
  uint32_t width = 0;
  uint32_t height = 0;
  int subtypeRank = 0;
};

/*
 * Ranks native camera formats without platform media types. The rule protects
 * against choosing a high-resolution but unusably low-FPS stream, while still
 * letting the requested size win when frame rates are practically comparable:
 *
 * 1. FPS bands win only when they differ by more than one band. Bands are
 *    target-ish, comparable capture FPS (>= max(24, 80% of target) up to 2x
 *    target), usable (>=15), low, and unknown.
 * 2. Prefer cheap raw formats before pixel-distance so MJPG never wins just
 *    because it is closer to the requested size.
 * 3. Same or adjacent bands are comparable; choose the pixel count closest to
 *    the requested size.
 * 4. If size does not decide, choose FPS closest to the target, with rates
 *    above target penalized by one step so target-or-below rates win ties.
 */
inline bool betterCameraMediaType(const CameraMediaTypeRank &candidate,
                                  const CameraMediaTypeRank &current,
                                  uint32_t requestedWidth,
                                  uint32_t requestedHeight,
                                  uint32_t requestedFps) {
  const double targetFps = requestedFps == 0u ? 30.0 : static_cast<double>(requestedFps);

  const auto fpsBand = [targetFps](double fps) {
    if (fps <= 0.0) {
      return 4;
    }
    if (fps >= targetFps - 1.0 && fps <= targetFps) {
      return 0;
    }
    if (fps >= std::max(24.0, targetFps * 0.8) && fps <= targetFps * 2.0) {
      return 1;
    }
    if (fps >= 15.0) {
      return 2;
    }
    return 3;
  };

  const int candidateBand = fpsBand(candidate.fps);
  const int currentBand = fpsBand(current.fps);
  if (std::abs(candidateBand - currentBand) > 1) {
    return candidateBand < currentBand;
  }

  if (candidate.subtypeRank != current.subtypeRank) {
    return candidate.subtypeRank < current.subtypeRank;
  }

  const uint64_t requestedPixels =
      static_cast<uint64_t>(requestedWidth == 0u ? 1920u : requestedWidth) *
      (requestedHeight == 0u ? 1080u : requestedHeight);
  const auto pixelDistance = [requestedPixels](const CameraMediaTypeRank &type) {
    const uint64_t pixels = static_cast<uint64_t>(type.width) * type.height;
    return pixels > requestedPixels ? pixels - requestedPixels : requestedPixels - pixels;
  };
  const uint64_t candidateDistance = pixelDistance(candidate);
  const uint64_t currentDistance = pixelDistance(current);
  if (candidateDistance != currentDistance) {
    return candidateDistance < currentDistance;
  }

  if (candidateBand != currentBand) {
    return candidateBand < currentBand;
  }

  const auto fpsPenalty = [targetFps](double fps) {
    if (fps <= 0.0) {
      return std::numeric_limits<double>::infinity();
    }
    return std::abs(fps - targetFps) + (fps > targetFps ? 1.0 : 0.0);
  };
  const double candidateFpsPenalty = fpsPenalty(candidate.fps);
  const double currentFpsPenalty = fpsPenalty(current.fps);
  if (candidateFpsPenalty != currentFpsPenalty) {
    return candidateFpsPenalty < currentFpsPenalty;
  }

  return false;
}

}  // namespace broadify::meeting
