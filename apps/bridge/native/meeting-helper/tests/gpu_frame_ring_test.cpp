#include "compose/gpu_frame_ring.h"

#include <cassert>

using broadify::meeting::GpuFrameRing;

int main() {
  GpuFrameRing ring(3);
  assert(ring.depth() == 3u);
  assert(ring.current().index == 0u);
  assert(ring.slotReady(0, 0));

  const auto first = ring.acquireNext();
  assert(first.index == 1u);
  assert(first.fenceValue == 1u);
  assert(!ring.slotReady(first.index, 0u));
  assert(ring.slotReady(first.index, 1u));

  const auto second = ring.acquireNext();
  const auto third = ring.acquireNext();
  const auto fourth = ring.acquireNext();
  assert(second.index == 2u);
  assert(third.index == 0u);
  assert(fourth.index == 1u);
  assert(fourth.fenceValue == 4u);

  ring.markSignaled(2u, 11u);
  assert(ring.nextFenceValue() == 12u);
  assert(!ring.slotReady(2u, 10u));
  assert(ring.slotReady(2u, 11u));

  ring.reset();
  assert(ring.nextFenceValue() == 1u);
  assert(ring.current().index == 0u);
  assert(ring.slotReady(2u, 0u));
  return 0;
}
