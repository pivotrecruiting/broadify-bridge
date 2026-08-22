#include "keyer/segmentation_tier.h"

#include <iostream>

using broadify::meeting::AlphaMask;
using broadify::meeting::OsMaskBlob;
using broadify::meeting::SegmentationTier;
using broadify::meeting::SegmentationTierProbe;
using broadify::meeting::SegmentationTierDecision;
using broadify::meeting::SegmentationTierSelectionState;
using broadify::meeting::decideSegmentationTier;
using broadify::meeting::mapOsBackgroundMaskToAlphaMask;
using broadify::meeting::parseSegmentationTierOverride;
using broadify::meeting::refineTierAfterModnet320Probe;
using broadify::meeting::selectTierAfterCameraAttach;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "segmentation_tier_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  ok &= expect(parseSegmentationTierOverride(nullptr) == SegmentationTier::Auto,
               "unset override -> auto");
  ok &= expect(parseSegmentationTierOverride("os_mask") ==
                   SegmentationTier::OsMask,
               "os_mask override parses");
  ok &= expect(parseSegmentationTierOverride("modnet_320_ofd") ==
                   SegmentationTier::Modnet320Ofd,
               "modnet_320_ofd override parses");
  ok &= expect(parseSegmentationTierOverride("bogus") == SegmentationTier::Auto,
               "invalid override -> auto");

  {
    SegmentationTierProbe probe;
    probe.windows = true;
    probe.osMaskPropertyPresent = true;
    probe.osMaskCapabilityPresent = true;
    const auto decision = decideSegmentationTier(SegmentationTier::Auto, probe);
    ok &= expect(decision.tier == SegmentationTier::OsMask,
                 "auto selects OS mask when mask capability is present");
    ok &= expect(decision.shouldEnableOsMask, "OS mask decision enables mask");
  }
  {
    SegmentationTierProbe probe;
    probe.windows = true;
    probe.osMaskPropertyPresent = true;
    probe.osMaskCapabilityPresent = false;
    const auto decision = decideSegmentationTier(SegmentationTier::Auto, probe);
    ok &= expect(decision.tier == SegmentationTier::Modnet512Ofd,
                 "property without mask falls back to T2");
    ok &= expect(decision.shouldDisableOsEffects,
                 "property without mask disables OS effects");
  }
  {
    SegmentationTierProbe probe;
    probe.windows = true;
    probe.integratedGpuOnly = true;
    probe.selfieLandscapeAssetPresent = true;
    probe.modnet320ProbeMs = 50.0;
    probe.frameBudgetMs = 33.0;
    const auto decision = decideSegmentationTier(SegmentationTier::Auto, probe);
    ok &= expect(decision.tier == SegmentationTier::SelfieLandscape,
                 "iGPU-only over-budget MODNet selects selfie tier");
  }
  {
    SegmentationTierProbe probe;
    probe.windows = true;
    const auto decision =
        decideSegmentationTier(SegmentationTier::SelfieLandscape, probe);
    ok &= expect(decision.tier == SegmentationTier::Modnet512Ofd,
                 "unavailable forced selfie tier falls back safely");
  }
  {
    SegmentationTierProbe probe;
    probe.windows = true;
    probe.frameBudgetMs = 33.0;
    SegmentationTierSelectionState selection;
    SegmentationTierDecision decision;
    ok &= expect(!selection.selected, "tier selection starts pending");
    ok &= expect(selectTierAfterCameraAttach(selection, probe, decision),
                 "camera attach runs first tier decision");
    ok &= expect(selection.selected &&
                     selection.active == SegmentationTier::Modnet512Ofd,
                 "attach decision selects MODNet before probe");
    ok &= expect(refineTierAfterModnet320Probe(selection, probe, 50.0,
                                              decision),
                 "first MODNet 320 probe refines auto tier");
    ok &= expect(selection.active == SegmentationTier::Modnet320Ofd,
                 "over-budget probe selects 320 tier");
    ok &= expect(!refineTierAfterModnet320Probe(selection, probe, 60.0,
                                               decision),
                 "probe refinement is one-shot");
  }
  {
    SegmentationTierProbe probe;
    probe.windows = true;
    probe.osMaskPropertyPresent = true;
    probe.osMaskCapabilityPresent = true;
    SegmentationTierSelectionState selection;
    selection.requested = SegmentationTier::OsMask;
    SegmentationTierDecision decision;
    ok &= expect(selectTierAfterCameraAttach(selection, probe, decision) &&
                     selection.active == SegmentationTier::OsMask,
                 "forced OS mask is honoured after attach probe succeeds");
  }
  {
    OsMaskBlob blob;
    blob.maskWidth = 4;
    blob.maskHeight = 2;
    blob.maskCoverageBox = {0, 0, 4, 2};
    blob.foregroundBox = {1, 0, 2, 2};
    blob.alpha = {
        0, 10, 20, 0,
        0, 30, 40, 0,
    };
    AlphaMask out;
    ok &= expect(mapOsBackgroundMaskToAlphaMask(blob, 4, 2, 99, out),
                 "synthetic OS mask maps to AlphaMask");
    ok &= expect(out.width == 4 && out.height == 2 && out.timestampNs == 99,
                 "mapped mask dimensions and timestamp");
    ok &= expect(out.alpha.size() == 8u && out.alpha[0] == 0 &&
                     out.alpha[1] == 10 && out.alpha[2] == 20 &&
                     out.alpha[3] == 0 && out.alpha[5] == 30 &&
                     out.alpha[6] == 40,
                 "coverage box scales while foreground box clips output");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "segmentation_tier_test passed" << std::endl;
  return 0;
}
