#pragma once

#include <cstdint>

namespace broadify::meeting {

struct GpuResidentConsumers {
  bool recorder = false;
  bool mjpegPreview = false;
  bool framebus = false;
  bool vcamTcp = false;
};

uint32_t cpuFrameCopiesPerFrame(bool gpuResidentEnabled,
                                const GpuResidentConsumers &consumers);

}  // namespace broadify::meeting
