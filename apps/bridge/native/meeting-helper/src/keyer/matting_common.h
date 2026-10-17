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

// How the camera frame is placed into the square MODNet input tensor.
// Letterbox: aspect-preserving, centred, mid-grey (normalized 0.0) bars.
// Fill: the whole frame stretched over the full square (no bars) - the macOS
// CoreML production path and the training geometry. The tensor shape is the
// same for both, so prebuilt per-size sessions stay valid.
enum class ModnetInputGeometry { Letterbox, Fill };

// Placement of the source frame inside the model input tensor. The name is
// historical: it describes both geometries. For Letterbox, maskOutputWidth/
// maskOutputHeight equal contentWidth/contentHeight. For Fill, content covers
// the whole tensor and maskOutputWidth/maskOutputHeight keep the letterbox
// content dimensions, so the emitted AlphaMask has the same size for both.
struct ModnetLetterboxMapping {
  uint32_t inputWidth = 0;
  uint32_t inputHeight = 0;
  uint32_t contentX = 0;
  uint32_t contentY = 0;
  uint32_t contentWidth = 0;
  uint32_t contentHeight = 0;
  ModnetInputGeometry geometry = ModnetInputGeometry::Letterbox;
  uint32_t maskOutputWidth = 0;
  uint32_t maskOutputHeight = 0;
};

ModnetLetterboxMapping modnetLetterboxMapping(uint32_t sourceWidth,
                                              uint32_t sourceHeight,
                                              uint32_t inputWidth,
                                              uint32_t inputHeight);

// Fill mapping: content = the whole inputWidth x inputHeight tensor; the mask
// output dimensions are the content dimensions modnetLetterboxMapping returns
// for the same arguments (e.g. 512x288, 320x180, 256x144 for 1920x1080). Zero
// dimensions yield an empty mapping like modnetLetterboxMapping.
ModnetLetterboxMapping modnetFillMapping(uint32_t sourceWidth,
                                         uint32_t sourceHeight,
                                         uint32_t inputWidth,
                                         uint32_t inputHeight);

// Dispatches to modnetLetterboxMapping or modnetFillMapping.
ModnetLetterboxMapping modnetInputMapping(uint32_t sourceWidth,
                                          uint32_t sourceHeight,
                                          uint32_t inputWidth,
                                          uint32_t inputHeight,
                                          ModnetInputGeometry geometry);

// Pure geometry selector: Letterbox when !isWindows or when
// letterboxEnvValue is exactly "1" (kill switch); Fill otherwise.
ModnetInputGeometry modnetInputGeometryFor(bool isWindows,
                                           const char *letterboxEnvValue);

// modnetInputGeometryFor for the compiled platform (isWindows = _WIN32) and
// BROADIFY_MEETING_KEYER_LETTERBOX, read once per process.
ModnetInputGeometry modnetInputGeometryForThisPlatform();

// Letterbox or fill placement + area-average RGBA downsample + NCHW float
// tensor build. Letterbox padding is filled with normalized 0.0, equivalent
// to the model's mean colour before normalization. Fill writes no padding: on
// upscale an empty source block takes its nearest source row/column (the
// zero-copy shader's bounds rule). MODNet normalizes input as
// (value/255 - 0.5)/0.5 -> range [-1,1] (mean/std 0.5 per channel), NOT
// ImageNet mean/std. Channel order is RGB (our frames are already RGBA), NCHW.
void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor,
                            ModnetLetterboxMapping *mapping = nullptr,
                            ModnetInputGeometry geometry =
                                ModnetInputGeometry::Letterbox);

// Mask readback. Letterbox: crop the model's letterboxed alpha back to the
// source-aspect content region and emit that model-resolution crop. Fill:
// bilinearly resample the full model alpha to maskOutputWidth x
// maskOutputHeight (the letterbox content size). The frame dimensions are
// accepted only for call-site compatibility; consumers resample when needed. A
// null mask or zero dimension leaves outputMask untouched.
void copyModnetAlphaMask(const float *mask, uint32_t maskWidth,
                         uint32_t maskHeight,
                         const ModnetLetterboxMapping &mapping,
                         uint32_t outputWidth,
                         uint32_t outputHeight,
                         uint64_t timestampNs,
                         AlphaMask &outputMask);

}  // namespace broadify::meeting
