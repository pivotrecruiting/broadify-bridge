#include "pipeline/gpu_resident_consumer_policy.h"

namespace broadify::meeting {

uint32_t cpuFrameCopiesPerFrame(bool gpuResidentEnabled,
                                const GpuResidentConsumers &consumers) {
  if (!gpuResidentEnabled) {
    return 0u;
  }
  uint32_t copies = 0;
  if (consumers.recorder) ++copies;
  if (consumers.mjpegPreview) ++copies;
  if (consumers.framebus) ++copies;
  if (consumers.vcamTcp) ++copies;
  return copies;
}

}  // namespace broadify::meeting
