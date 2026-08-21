#include "compose/staging_readback_ring.h"

#include <iostream>

using broadify::meeting::StagingReadbackRing;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "staging_readback_ring_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  StagingReadbackRing ring;
  ok &= expect(ring.depth() == 3, "default depth is 3");

  const auto d0 = ring.advance();
  ok &= expect(d0.copyIndex == 0, "frame 0 copies slot 0");
  ok &= expect(d0.preferredMapIndex == 2, "frame 0 preferred wraps");
  ok &= expect(!d0.allowBlockingFallback, "frame 0 cannot block");

  const auto d1 = ring.advance();
  ok &= expect(d1.copyIndex == 1, "frame 1 copies slot 1");
  ok &= expect(d1.preferredMapIndex == 0, "frame 1 maps N-1");
  ok &= expect(!d1.allowBlockingFallback, "frame 1 cannot block");

  const auto d2 = ring.advance();
  ok &= expect(d2.copyIndex == 2, "frame 2 copies slot 2");
  ok &= expect(d2.preferredMapIndex == 1, "frame 2 maps N-1");
  ok &= expect(d2.fallbackMapIndex == 0, "frame 2 fallback maps N-2");
  ok &= expect(d2.allowBlockingFallback, "frame 2 may block on N-2");

  const auto d3 = ring.advance();
  ok &= expect(d3.copyIndex == 0, "frame 3 copies slot 0");
  ok &= expect(d3.preferredMapIndex == 2, "frame 3 maps N-1");
  ok &= expect(d3.fallbackMapIndex == 1, "frame 3 fallback maps N-2");

  return ok ? 0 : 1;
}
