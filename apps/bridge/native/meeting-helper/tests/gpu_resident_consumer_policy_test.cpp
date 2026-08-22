#include "pipeline/gpu_resident_consumer_policy.h"

#include <cassert>

using broadify::meeting::GpuResidentConsumers;
using broadify::meeting::cpuFrameCopiesPerFrame;

int main() {
  assert(cpuFrameCopiesPerFrame(false, GpuResidentConsumers{true, true, true, true}) == 0u);
  assert(cpuFrameCopiesPerFrame(true, GpuResidentConsumers{}) == 0u);
  assert(cpuFrameCopiesPerFrame(true, GpuResidentConsumers{true, false, false, false}) == 1u);
  assert(cpuFrameCopiesPerFrame(true, GpuResidentConsumers{false, true, true, true}) == 3u);
  return 0;
}
