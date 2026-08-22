#include "pipeline/compositor_input_selection.h"

#include <cstdint>
#include <iostream>

using broadify::meeting::AlphaMask;
using broadify::meeting::AsyncKeyerCompositorFrame;
using broadify::meeting::GovernorOffCompositorInput;
using broadify::meeting::selectAsyncKeyerCompositorFrame;
using broadify::meeting::selectGovernorOffCompositorInput;
using broadify::meeting::selectRetainedOrEmptyMaskForLiveKeyer;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "compositor_input_selection_test failed: " << what
              << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(selectGovernorOffCompositorInput(true) ==
                   GovernorOffCompositorInput::LastMask,
               "governor Off holds the last good mask");
  ok &= expect(selectGovernorOffCompositorInput(false) ==
                   GovernorOffCompositorInput::BackgroundOnly,
               "governor Off uses background-only when no mask exists");
  AlphaMask lastGood;
  lastGood.width = 2u;
  lastGood.height = 1u;
  lastGood.timestampNs = 1'000'000'000ull;
  lastGood.alpha = {255u, 128u};
  AlphaMask selected;
  ok &= expect(selectRetainedOrEmptyMaskForLiveKeyer(
                   lastGood, 2'500'000'000ull, 4u, 2u, selected),
               "live keyer selects retained mask within 2s");
  ok &= expect(selected.alpha == lastGood.alpha &&
                   selected.timestampNs == 2'500'000'000ull &&
                   !selected.emptyValid,
               "retained mask is timestamp-rebased but otherwise unchanged");
  ok &= expect(selectRetainedOrEmptyMaskForLiveKeyer(
                   lastGood, 3'100'000'000ull, 4u, 2u, selected),
               "live keyer selects empty mask after retention expires");
  ok &= expect(selected.width == 4u && selected.height == 2u &&
                   selected.alpha.size() == 8u && selected.emptyValid,
               "expired retention becomes a keyed zero mask");
  ok &= expect(selectRetainedOrEmptyMaskForLiveKeyer(
                   AlphaMask{}, 5'000'000ull, 3u, 2u, selected),
               "startup with loaded keyer selects empty mask");
  ok &= expect(selected.width == 3u && selected.height == 2u &&
                   selected.emptyValid,
               "startup empty mask uses current frame dimensions");
  ok &= expect(selectAsyncKeyerCompositorFrame(true, true, true) ==
                   AsyncKeyerCompositorFrame::PairedFrame,
               "VCam connected uses the paired keyer frame");
  ok &= expect(selectAsyncKeyerCompositorFrame(false, true, true) ==
                   AsyncKeyerCompositorFrame::LatestCameraFrame,
               "non-VCam async path can live-snap when available");
  ok &= expect(selectAsyncKeyerCompositorFrame(false, true, false) ==
                   AsyncKeyerCompositorFrame::PairedFrame,
               "non-VCam async path defaults to the paired keyer frame");
  ok &= expect(selectAsyncKeyerCompositorFrame(true, false, true) ==
                   AsyncKeyerCompositorFrame::LatestCameraFrame,
               "unusable pair falls back to the latest camera frame");
  return ok ? 0 : 1;
}
