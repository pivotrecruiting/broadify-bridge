#include "compose/staging_readback_ring.h"

#include <array>
#include <iostream>

using broadify::meeting::StagingReadbackRing;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "staging_readback_ring_test failed: " << what << std::endl;
  }
  return condition;
}

bool expectWrittenSlot(const std::array<bool, 3> &written, size_t index,
                       const char *what) {
  return expect(index < written.size() && written[index], what);
}

}  // namespace

int main() {
  bool ok = true;
  StagingReadbackRing ring;
  std::array<bool, 3> written = {};
  ok &= expect(ring.depth() == 3, "default depth is 3");

  const auto d0 = ring.advance();
  written[d0.copyIndex] = true;
  ok &= expect(d0.copyIndex == 0, "frame 0 copies slot 0");
  ok &= expect(d0.preferredMapIndex == 2, "frame 0 preferred wraps");
  ok &= expect(!d0.preferredMapValid, "frame 0 preferred is unwritten");
  ok &= expect(!d0.allowBlockingFallback, "frame 0 has no older fallback");
  ok &= expectWrittenSlot(written, d0.copyIndex, "frame 0 copied slot is written");

  const auto d1 = ring.advance();
  written[d1.copyIndex] = true;
  ok &= expect(d1.copyIndex == 1, "frame 1 copies slot 1");
  ok &= expect(d1.preferredMapIndex == 0, "frame 1 maps N-1");
  ok &= expect(d1.preferredMapValid, "frame 1 preferred is written");
  ok &= expect(!d1.allowBlockingFallback, "frame 1 cannot block");
  ok &= expectWrittenSlot(written, d1.preferredMapIndex, "frame 1 maps written preferred");

  const auto d2 = ring.advance();
  written[d2.copyIndex] = true;
  ok &= expect(d2.copyIndex == 2, "frame 2 copies slot 2");
  ok &= expect(d2.preferredMapIndex == 1, "frame 2 maps N-1");
  ok &= expect(d2.fallbackMapIndex == 0, "frame 2 fallback maps N-2");
  ok &= expect(d2.preferredMapValid, "frame 2 preferred is written");
  ok &= expect(d2.allowBlockingFallback, "frame 2 may block on N-2");
  ok &= expectWrittenSlot(written, d2.preferredMapIndex, "frame 2 maps written preferred");
  ok &= expectWrittenSlot(written, d2.fallbackMapIndex, "frame 2 maps written fallback");

  const auto d3 = ring.advance();
  written[d3.copyIndex] = true;
  ok &= expect(d3.copyIndex == 0, "frame 3 copies slot 0");
  ok &= expect(d3.preferredMapIndex == 2, "frame 3 maps N-1");
  ok &= expect(d3.fallbackMapIndex == 1, "frame 3 fallback maps N-2");
  ok &= expect(d3.preferredMapValid, "frame 3 preferred is written");
  ok &= expect(d3.allowBlockingFallback, "frame 3 may block on N-2");
  ok &= expectWrittenSlot(written, d3.preferredMapIndex, "frame 3 maps written preferred");
  ok &= expectWrittenSlot(written, d3.fallbackMapIndex, "frame 3 maps written fallback");

  ring.reset();
  written = {};
  const auto reset0 = ring.advance();
  written[reset0.copyIndex] = true;
  ok &= expect(!reset0.preferredMapValid, "reset frame 0 preferred is unwritten");
  ok &= expectWrittenSlot(written, reset0.copyIndex, "reset frame 0 copied slot is written");

  ring.reset();
  for (size_t frame = 0; frame < 6; ++frame) {
    const auto current = ring.advanceCurrentFrame();
    ok &= expect(current.copyIndex == frame % 3, "current frame copies expected slot");
    ok &= expect(current.preferredMapIndex == current.copyIndex,
                 "current frame maps the copied slot");
    ok &= expect(current.fallbackMapIndex == current.copyIndex,
                 "current frame fallback is the copied slot");
    ok &= expect(current.preferredMapValid, "current frame map is valid");
    ok &= expect(current.allowBlockingFallback,
                 "current frame permits blocking map");
    ok &= expect(current.mapsCurrentFrame,
                 "current frame decision reports current mask");
  }

  return ok ? 0 : 1;
}
