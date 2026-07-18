#pragma once

#include "keyer/keyer.h"

#include <memory>

#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>

namespace broadify::meeting {

// GPU mask refinement. Takes the low-res
// CoreML alpha matte (as a OneComponent16Half CVPixelBuffer) and the camera
// frame, and runs Apple's MPSImageGuidedFilter on the GPU to produce a clean,
// edge-aligned higher-res mask, replacing the CPU joint-bilateral refine. The
// guided filter's two-stage design (regression at low res, joint-upsampling
// reconstruction against the full-res frame) is exactly the fast-guided-filter
// matting pipeline. Stage 2 still reads the result back to a CPU AlphaMask.
class GpuMaskRefiner {
 public:
  GpuMaskRefiner();
  ~GpuMaskRefiner();

  bool available() const;

  // Refines `alpha` (CoreML output, retained by the caller) guided by `camera`
  // (full-res RGBA), writing the result into `out`. Returns false on any failure
  // so the caller can fall back to the CPU path.
  bool refine(CVPixelBufferRef alpha, const VideoFrame &camera, AlphaMask &out);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
#endif  // __APPLE__
