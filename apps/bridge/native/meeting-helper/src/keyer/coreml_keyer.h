#pragma once

#include "keyer/keyer.h"

#include <memory>
#include <string>

namespace broadify::meeting {

// Native Core ML MODNet keyer (macOS). Runs the converted MODNet.mlpackage via
// MLModel, feeding the camera frame as a CVPixelBuffer (normalization baked into
// the model) and reading the alpha matte back. This replaces the ONNX Runtime
// path (which cannot do zero-copy GPU I/O). Stage 1 of the GPU rework still reads
// the mask back to the CPU; later stages keep it on the GPU as an MTLTexture.
class CoreMLKeyer final : public Keyer {
 public:
  explicit CoreMLKeyer(std::string modelsDir);
  ~CoreMLKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;

  // Fused GPU path: predict + GPU guided-filter refine in one scope, returning a
  // BORROWED mask MTLTexture handle ((__bridge void *)id<MTLTexture>, valid until
  // the next call) — the mask never leaves the GPU (no CPU readback). Returns
  // nullptr on failure/unavailability so the caller falls back. width/height
  // receive the texture size. (No-op stub off Apple.)
  void *predictMaskTexture(const VideoFrame &input, uint32_t &width, uint32_t &height);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
