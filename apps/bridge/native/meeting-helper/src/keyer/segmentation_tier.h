#pragma once

#include "keyer/keyer.h"

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

enum class SegmentationTier {
  Auto,
  OsMask,
  Modnet512Ofd,
  Modnet320Ofd,
  SelfieLandscape,
};

struct SegmentationTierProbe {
  bool windows = false;
  bool osMaskPropertyPresent = false;
  bool osMaskCapabilityPresent = false;
  bool selfieLandscapeAssetPresent = false;
  bool integratedGpuOnly = false;
  double modnet320ProbeMs = 0.0;
  double frameBudgetMs = 1000.0 / 30.0;
};

struct SegmentationTierDecision {
  SegmentationTier tier = SegmentationTier::Modnet512Ofd;
  std::string reason = "default";
  bool shouldEnableOsMask = false;
  bool shouldDisableOsEffects = false;
};

struct OsMaskRect {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

struct OsMaskBlob {
  uint32_t maskWidth = 0;
  uint32_t maskHeight = 0;
  OsMaskRect maskCoverageBox;
  OsMaskRect foregroundBox;
  std::vector<uint8_t> alpha;
};

SegmentationTier parseSegmentationTierOverride(const char *value);
const char *segmentationTierName(SegmentationTier tier);
SegmentationTierDecision decideSegmentationTier(
    SegmentationTier requested,
    const SegmentationTierProbe &probe);

bool mapOsBackgroundMaskToAlphaMask(const OsMaskBlob &blob,
                                    uint32_t frameWidth,
                                    uint32_t frameHeight,
                                    uint64_t timestampNs,
                                    AlphaMask &out);

}  // namespace broadify::meeting
