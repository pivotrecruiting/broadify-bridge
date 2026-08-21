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

struct ModnetLetterboxMapping {
  uint32_t inputWidth = 0;
  uint32_t inputHeight = 0;
  uint32_t contentX = 0;
  uint32_t contentY = 0;
  uint32_t contentWidth = 0;
  uint32_t contentHeight = 0;
};

ModnetLetterboxMapping modnetLetterboxMapping(uint32_t sourceWidth,
                                              uint32_t sourceHeight,
                                              uint32_t inputWidth,
                                              uint32_t inputHeight);

// Aspect-preserving letterbox + area-average RGBA downsample + NCHW float
// tensor build. Padding is filled with normalized 0.0, equivalent to the
// model's mean colour before normalization. MODNet normalizes input as
// (value/255 - 0.5)/0.5 -> range [-1,1] (mean/std 0.5 per channel), NOT
// ImageNet mean/std. Channel order is RGB (our frames are already RGBA), NCHW.
void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor,
                            ModnetLetterboxMapping *mapping = nullptr);

// Mask readback: crop the model's letterboxed alpha back to the source-aspect
// content region, then bilinearly resample it to the working frame size. A null
// mask or zero dimension leaves outputMask untouched.
void copyModnetAlphaMask(const float *mask, uint32_t maskWidth,
                         uint32_t maskHeight,
                         const ModnetLetterboxMapping &mapping,
                         uint32_t outputWidth,
                         uint32_t outputHeight,
                         uint64_t timestampNs,
                         AlphaMask &outputMask);

}  // namespace broadify::meeting
