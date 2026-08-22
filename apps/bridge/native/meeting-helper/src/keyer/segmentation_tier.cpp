#include "keyer/segmentation_tier.h"

#include <algorithm>
#include <cmath>

namespace broadify::meeting {
namespace {

bool tierAvailable(SegmentationTier tier, const SegmentationTierProbe &probe) {
  switch (tier) {
    case SegmentationTier::Auto:
      return true;
    case SegmentationTier::OsMask:
      return probe.windows && probe.osMaskPropertyPresent &&
             probe.osMaskCapabilityPresent;
    case SegmentationTier::Modnet512Ofd:
    case SegmentationTier::Modnet320Ofd:
      return probe.windows;
    case SegmentationTier::SelfieLandscape:
      return probe.windows && probe.selfieLandscapeAssetPresent;
  }
  return false;
}

SegmentationTierDecision unavailable(SegmentationTier tier) {
  SegmentationTierDecision decision;
  decision.tier = SegmentationTier::Modnet512Ofd;
  decision.reason = std::string(segmentationTierName(tier)) + "_unavailable";
  return decision;
}

}  // namespace

SegmentationTier parseSegmentationTierOverride(const char *value) {
  if (value == nullptr || value[0] == '\0' || std::string(value) == "auto") {
    return SegmentationTier::Auto;
  }
  const std::string raw(value);
  if (raw == "os_mask") {
    return SegmentationTier::OsMask;
  }
  if (raw == "modnet_512_ofd") {
    return SegmentationTier::Modnet512Ofd;
  }
  if (raw == "modnet_320_ofd") {
    return SegmentationTier::Modnet320Ofd;
  }
  if (raw == "selfie_landscape") {
    return SegmentationTier::SelfieLandscape;
  }
  return SegmentationTier::Auto;
}

const char *segmentationTierName(SegmentationTier tier) {
  switch (tier) {
    case SegmentationTier::Auto:
      return "auto";
    case SegmentationTier::OsMask:
      return "os_mask";
    case SegmentationTier::Modnet512Ofd:
      return "modnet_512_ofd";
    case SegmentationTier::Modnet320Ofd:
      return "modnet_320_ofd";
    case SegmentationTier::SelfieLandscape:
      return "selfie_landscape";
  }
  return "auto";
}

SegmentationTierDecision decideSegmentationTier(
    SegmentationTier requested,
    const SegmentationTierProbe &probe) {
  if (requested != SegmentationTier::Auto) {
    if (!tierAvailable(requested, probe)) {
      SegmentationTierDecision decision = unavailable(requested);
      decision.shouldDisableOsEffects =
          probe.windows && probe.osMaskPropertyPresent &&
          !probe.osMaskCapabilityPresent;
      return decision;
    }
    SegmentationTierDecision decision;
    decision.tier = requested;
    decision.reason = "env_override";
    decision.shouldEnableOsMask = requested == SegmentationTier::OsMask;
    return decision;
  }

  if (probe.windows && probe.osMaskPropertyPresent &&
      probe.osMaskCapabilityPresent) {
    return {SegmentationTier::OsMask, "windows_os_mask_capability",
            true, false};
  }
  if (probe.windows && probe.osMaskPropertyPresent) {
    SegmentationTierDecision decision;
    decision.tier = SegmentationTier::Modnet512Ofd;
    decision.reason = "os_mask_property_without_mask_capability";
    decision.shouldDisableOsEffects = true;
    return decision;
  }
  if (probe.windows && probe.integratedGpuOnly &&
      probe.selfieLandscapeAssetPresent && probe.modnet320ProbeMs > 0.0 &&
      probe.frameBudgetMs > 0.0 && probe.modnet320ProbeMs > probe.frameBudgetMs) {
    return {SegmentationTier::SelfieLandscape, "igpu_modnet320_over_budget",
            false, false};
  }
  if (probe.windows && probe.modnet320ProbeMs > 0.0 &&
      probe.frameBudgetMs > 0.0 && probe.modnet320ProbeMs > probe.frameBudgetMs) {
    return {SegmentationTier::Modnet320Ofd, "modnet512_predicted_over_budget",
            false, false};
  }
  return {SegmentationTier::Modnet512Ofd, "windows_modnet_default", false,
          false};
}

bool selectTierAfterCameraAttach(SegmentationTierSelectionState &state,
                                 const SegmentationTierProbe &probe,
                                 SegmentationTierDecision &decision) {
  state.cameraAttached = true;
  decision = decideSegmentationTier(state.requested, probe);
  state.active = decision.tier;
  state.reason = decision.reason;
  state.selected = true;
  return true;
}

bool refineTierAfterModnet320Probe(SegmentationTierSelectionState &state,
                                   const SegmentationTierProbe &probe,
                                   double modnet320ProbeMs,
                                   SegmentationTierDecision &decision) {
  if (!state.cameraAttached || !state.selected || state.refinedFromProbe ||
      state.requested != SegmentationTier::Auto || modnet320ProbeMs <= 0.0) {
    return false;
  }
  SegmentationTierProbe refinedProbe = probe;
  refinedProbe.modnet320ProbeMs = modnet320ProbeMs;
  decision = decideSegmentationTier(state.requested, refinedProbe);
  state.active = decision.tier;
  state.reason = decision.reason;
  state.refinedFromProbe = true;
  state.modnet320ProbeMs = modnet320ProbeMs;
  return true;
}

bool mapOsBackgroundMaskToAlphaMask(const OsMaskBlob &blob,
                                    uint32_t frameWidth,
                                    uint32_t frameHeight,
                                    uint64_t timestampNs,
                                    AlphaMask &out) {
  if (blob.maskWidth == 0u || blob.maskHeight == 0u || frameWidth == 0u ||
      frameHeight == 0u ||
      blob.alpha.size() <
          static_cast<size_t>(blob.maskWidth) * blob.maskHeight) {
    return false;
  }
  const OsMaskRect coverage =
      blob.maskCoverageBox.width == 0u || blob.maskCoverageBox.height == 0u
          ? OsMaskRect{0u, 0u, frameWidth, frameHeight}
          : blob.maskCoverageBox;
  const uint32_t coverageX = std::min(coverage.x, frameWidth - 1u);
  const uint32_t coverageY = std::min(coverage.y, frameHeight - 1u);
  const uint32_t coverageW = std::min(coverage.width, frameWidth - coverageX);
  const uint32_t coverageH = std::min(coverage.height, frameHeight - coverageY);
  const uint32_t fgX = std::min(blob.foregroundBox.x, blob.maskWidth);
  const uint32_t fgY = std::min(blob.foregroundBox.y, blob.maskHeight);
  const uint32_t fgW = std::min(blob.foregroundBox.width, blob.maskWidth - fgX);
  const uint32_t fgH =
      std::min(blob.foregroundBox.height, blob.maskHeight - fgY);
  if (coverageW == 0u || coverageH == 0u || fgW == 0u || fgH == 0u) {
    return false;
  }

  out.width = frameWidth;
  out.height = frameHeight;
  out.timestampNs = timestampNs;
  out.emptyValid = false;
  out.alpha.assign(static_cast<size_t>(frameWidth) * frameHeight, 0u);
  const uint32_t fgRight = fgX + fgW;
  const uint32_t fgBottom = fgY + fgH;
  for (uint32_t y = coverageY; y < coverageY + coverageH; ++y) {
    const uint32_t sourceY = static_cast<uint32_t>(
        (static_cast<uint64_t>(y - coverageY) * blob.maskHeight) / coverageH);
    if (sourceY < fgY || sourceY >= fgBottom) {
      continue;
    }
    for (uint32_t x = coverageX; x < coverageX + coverageW; ++x) {
      const uint32_t sourceX = static_cast<uint32_t>(
          (static_cast<uint64_t>(x - coverageX) * blob.maskWidth) / coverageW);
      if (sourceX < fgX || sourceX >= fgRight) {
        continue;
      }
      out.alpha[static_cast<size_t>(y) * frameWidth + x] =
          blob.alpha[static_cast<size_t>(sourceY) * blob.maskWidth + sourceX];
    }
  }
  return true;
}

}  // namespace broadify::meeting
