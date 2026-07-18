#pragma once

#include "keyer/keyer.h"

#include <memory>
#include <string>

namespace broadify::meeting {

// Native Core ML MODNet keyer (macOS). Runs the converted MODNet.mlpackage via
// MLModel, feeding the camera frame as a CVPixelBuffer (normalization baked into
// the model) and reading the alpha matte back. The CPU mask is shared with the
// Metal compositor, which handles camera and graphics composition on the GPU.
class CoreMLKeyer final : public Keyer {
 public:
  explicit CoreMLKeyer(std::string modelsDir);
  ~CoreMLKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;

  void *predictMaskTexture(const VideoFrame &input, uint32_t &width,
                           uint32_t &height);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
