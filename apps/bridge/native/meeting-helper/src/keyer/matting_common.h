#pragma once

#include "keyer/keyer.h"

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

// Shared MODNet pre-/post-processing used by every matting backend (ONNX
// Runtime and OpenVINO). Pure stdlib: no inference-runtime includes, so these
// helpers compile everywhere, including the dependency-free ctest binaries.
// Behavior must stay byte-identical across backends - the keyer self-test and
// the governor tests rely on it.

// Square MODNet input resolution derived from the performance mode. The model
// accepts dynamic input dimensions, so lowering this is the primary lever for
// inference latency on weak GPUs/CPUs. Masks below 400px are edge-refined by
// the joint-bilateral upsampler in the frame pipeline, which recovers detail.
// high_quality = 512, balanced = 320, performance = 256; unknown values map to
// high_quality.
uint32_t modnetInputSizeForMode(const std::string &performanceMode);

// Nearest-neighbor RGBA resize + NCHW float tensor build. MODNet normalizes
// input as (value/255 - 0.5)/0.5 -> range [-1,1] (mean/std 0.5 per channel),
// NOT ImageNet mean/std. Using ImageNet stats here silently degrades the
// matte. Channel order is RGB (our frames are already RGBA), NCHW.
void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor);

// Mask readback: clamp float [0,1] alpha to uint8 (round-to-nearest) into the
// AlphaMask. A null mask or a zero dimension leaves outputMask untouched.
void copyModnetAlphaMask(const float *mask, uint32_t maskWidth,
                         uint32_t maskHeight, uint64_t timestampNs,
                         AlphaMask &outputMask);

}  // namespace broadify::meeting
