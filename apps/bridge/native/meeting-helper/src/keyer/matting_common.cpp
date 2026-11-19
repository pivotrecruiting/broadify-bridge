#include "keyer/matting_common.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <cstring>

namespace broadify::meeting {
namespace {

// MODNet normalization constants; see the header for why these are 0.5/0.5
// and not ImageNet stats.
constexpr float kMean[3] = {0.5f, 0.5f, 0.5f};
constexpr float kStd[3] = {0.5f, 0.5f, 0.5f};

constexpr uint32_t kModnetInputHighQuality = 512u;
constexpr uint32_t kModnetInputBalanced = 320u;
constexpr uint32_t kModnetInputPerformance = 256u;

float normalized(float value) {
  return (value - kMean[0]) / kStd[0];
}

uint32_t scaledCropCoord(uint32_t sourceCoord,
                         uint32_t sourceExtent,
                         uint32_t targetExtent) {
  if (sourceExtent == 0u || targetExtent == 0u) {
    return 0u;
  }
  return static_cast<uint32_t>(std::llround(
      static_cast<double>(sourceCoord) * static_cast<double>(targetExtent) /
      static_cast<double>(sourceExtent)));
}

void writeIntegerBlockAverage(const VideoFrame &input,
                              uint32_t left,
                              uint32_t top,
                              uint32_t right,
                              uint32_t bottom,
                              size_t dstOffset,
                              size_t channelSize,
                              std::vector<float> &tensor) {
  if (input.width == 0u || input.height == 0u || right <= left ||
      bottom <= top) {
    tensor[dstOffset] = normalized(0.5f);
    tensor[channelSize + dstOffset] = normalized(0.5f);
    tensor[channelSize * 2u + dstOffset] = normalized(0.5f);
    return;
  }
  left = std::min(left, input.width - 1u);
  top = std::min(top, input.height - 1u);
  right = std::min(std::max(right, left + 1u), input.width);
  bottom = std::min(std::max(bottom, top + 1u), input.height);
  uint64_t sumR = 0u;
  uint64_t sumG = 0u;
  uint64_t sumB = 0u;
  for (uint32_t y = top; y < bottom; ++y) {
    size_t source = (static_cast<size_t>(y) * input.width + left) * 4u;
    for (uint32_t x = left; x < right; ++x) {
      sumR += input.rgba[source + 0u];
      sumG += input.rgba[source + 1u];
      sumB += input.rgba[source + 2u];
      source += 4u;
    }
  }
  const uint64_t count =
      static_cast<uint64_t>(right - left) * static_cast<uint64_t>(bottom - top);
  const double scale = count > 0u
                           ? 1.0 / (static_cast<double>(count) * 255.0)
                           : 1.0 / 255.0;
  tensor[dstOffset] = normalized(static_cast<float>(
      static_cast<double>(sumR) * scale));
  tensor[channelSize + dstOffset] = normalized(static_cast<float>(
      static_cast<double>(sumG) * scale));
  tensor[channelSize * 2u + dstOffset] = normalized(static_cast<float>(
      static_cast<double>(sumB) * scale));
}

// Fill-only block bounds with the zero-copy shader's rule
// (kBuildInputShader in dml_device_input.cpp): clamp begin into the source and
// widen an empty block to one pixel, so an upscaled extent samples its nearest
// source row/column instead of hitting writeIntegerBlockAverage's mid-grey
// early return. extent must be > 0 (a Fill mapping with content implies a
// non-empty source).
void clampFillBlockBounds(uint32_t &begin, uint32_t &end, uint32_t extent) {
  begin = std::min(begin, extent - 1u);
  end = std::min(std::max(end, begin + 1u), extent);
}

// One output coordinate of a separable bilinear resample: the two source
// samples and the weight of the second one.
struct BilinearTap {
  uint32_t index0 = 0;
  uint32_t index1 = 0;
  float weight1 = 0.0f;
};

// Pixel-centre aligned like OpenCV INTER_LINEAR:
// src = (dst + 0.5) * srcExtent / dstExtent - 0.5, clamped to
// [0, srcExtent - 1]; the weight is the fractional part. Equal extents map
// every coordinate onto itself with weight 0.
std::vector<BilinearTap> bilinearTaps(uint32_t srcExtent, uint32_t dstExtent) {
  std::vector<BilinearTap> taps(dstExtent);
  for (uint32_t dst = 0; dst < dstExtent; ++dst) {
    BilinearTap &tap = taps[dst];
    if (srcExtent == dstExtent) {
      tap.index0 = dst;
      tap.index1 = dst;
      continue;
    }
    double src = (static_cast<double>(dst) + 0.5) *
                     static_cast<double>(srcExtent) /
                     static_cast<double>(dstExtent) -
                 0.5;
    src = std::clamp(src, 0.0, static_cast<double>(srcExtent - 1u));
    const double base = std::floor(src);
    tap.index0 = static_cast<uint32_t>(base);
    tap.index1 = std::min(tap.index0 + 1u, srcExtent - 1u);
    tap.weight1 = static_cast<float>(src - base);
  }
  return taps;
}

uint8_t alphaToByte(float value) {
  const float alpha = std::clamp(value, 0.0f, 1.0f);
  return static_cast<uint8_t>(std::round(alpha * 255.0f));
}

// Fill readback: the whole model output is the stretched frame, so resample
// all of it to the letterbox content size (maskOutputWidth x
// maskOutputHeight) instead of cropping.
void copyFilledModnetAlphaMask(const float *mask, uint32_t maskWidth,
                               uint32_t maskHeight,
                               const ModnetLetterboxMapping &mapping,
                               uint64_t timestampNs,
                               AlphaMask &outputMask) {
  const uint32_t outputWidth = mapping.maskOutputWidth;
  const uint32_t outputHeight = mapping.maskOutputHeight;
  if (outputWidth == 0u || outputHeight == 0u) {
    return;
  }
  outputMask.width = outputWidth;
  outputMask.height = outputHeight;
  outputMask.timestampNs = timestampNs;
  outputMask.alpha.assign(static_cast<size_t>(outputWidth) * outputHeight, 0u);
  if (outputWidth == maskWidth && outputHeight == maskHeight) {
    for (size_t i = 0, n = outputMask.alpha.size(); i < n; ++i) {
      outputMask.alpha[i] = alphaToByte(mask[i]);
    }
    return;
  }
  const std::vector<BilinearTap> xTaps = bilinearTaps(maskWidth, outputWidth);
  const std::vector<BilinearTap> yTaps = bilinearTaps(maskHeight, outputHeight);
  for (uint32_t y = 0; y < outputHeight; ++y) {
    const BilinearTap &yTap = yTaps[y];
    const float *row0 = mask + static_cast<size_t>(yTap.index0) * maskWidth;
    const float *row1 = mask + static_cast<size_t>(yTap.index1) * maskWidth;
    const size_t rowOffset = static_cast<size_t>(y) * outputWidth;
    for (uint32_t x = 0; x < outputWidth; ++x) {
      const BilinearTap &xTap = xTaps[x];
      const float top = row0[xTap.index0] * (1.0f - xTap.weight1) +
                        row0[xTap.index1] * xTap.weight1;
      const float bottom = row1[xTap.index0] * (1.0f - xTap.weight1) +
                           row1[xTap.index1] * xTap.weight1;
      outputMask.alpha[rowOffset + x] =
          alphaToByte(top * (1.0f - yTap.weight1) + bottom * yTap.weight1);
    }
  }
}

}  // namespace

uint32_t modnetInputSizeForMode(const std::string &performanceMode) {
  if (performanceMode == "performance") {
    return kModnetInputPerformance;
  }
  if (performanceMode == "balanced") {
    return kModnetInputBalanced;
  }
  return kModnetInputHighQuality;  // high_quality / unknown -> full resolution
}

ModnetLetterboxMapping modnetLetterboxMapping(uint32_t sourceWidth,
                                              uint32_t sourceHeight,
                                              uint32_t inputWidth,
                                              uint32_t inputHeight) {
  ModnetLetterboxMapping mapping;
  mapping.inputWidth = inputWidth;
  mapping.inputHeight = inputHeight;
  if (sourceWidth == 0u || sourceHeight == 0u || inputWidth == 0u ||
      inputHeight == 0u) {
    return mapping;
  }

  const double scale = std::min(static_cast<double>(inputWidth) /
                                    static_cast<double>(sourceWidth),
                                static_cast<double>(inputHeight) /
                                    static_cast<double>(sourceHeight));
  mapping.contentWidth = std::max<uint32_t>(
      1u, std::min(inputWidth, static_cast<uint32_t>(
                                   std::llround(sourceWidth * scale))));
  mapping.contentHeight = std::max<uint32_t>(
      1u, std::min(inputHeight, static_cast<uint32_t>(
                                    std::llround(sourceHeight * scale))));
  mapping.contentX = (inputWidth - mapping.contentWidth) / 2u;
  mapping.contentY = (inputHeight - mapping.contentHeight) / 2u;
  mapping.maskOutputWidth = mapping.contentWidth;
  mapping.maskOutputHeight = mapping.contentHeight;
  return mapping;
}

ModnetLetterboxMapping modnetFillMapping(uint32_t sourceWidth,
                                         uint32_t sourceHeight,
                                         uint32_t inputWidth,
                                         uint32_t inputHeight) {
  const ModnetLetterboxMapping letterbox = modnetLetterboxMapping(
      sourceWidth, sourceHeight, inputWidth, inputHeight);
  ModnetLetterboxMapping mapping;
  mapping.inputWidth = inputWidth;
  mapping.inputHeight = inputHeight;
  mapping.geometry = ModnetInputGeometry::Fill;
  if (letterbox.contentWidth == 0u || letterbox.contentHeight == 0u) {
    return mapping;
  }
  mapping.contentX = 0u;
  mapping.contentY = 0u;
  mapping.contentWidth = inputWidth;
  mapping.contentHeight = inputHeight;
  // Keep the emitted mask at the letterbox content size so every consumer
  // sees exactly the dimensions it saw before.
  mapping.maskOutputWidth = letterbox.contentWidth;
  mapping.maskOutputHeight = letterbox.contentHeight;
  return mapping;
}

ModnetLetterboxMapping modnetInputMapping(uint32_t sourceWidth,
                                          uint32_t sourceHeight,
                                          uint32_t inputWidth,
                                          uint32_t inputHeight,
                                          ModnetInputGeometry geometry) {
  if (geometry == ModnetInputGeometry::Fill) {
    return modnetFillMapping(sourceWidth, sourceHeight, inputWidth,
                             inputHeight);
  }
  return modnetLetterboxMapping(sourceWidth, sourceHeight, inputWidth,
                                inputHeight);
}

ModnetInputGeometry modnetInputGeometryFor(bool isWindows,
                                           const char *letterboxEnvValue) {
  if (!isWindows) {
    return ModnetInputGeometry::Letterbox;
  }
  if (letterboxEnvValue != nullptr &&
      std::strcmp(letterboxEnvValue, "1") == 0) {
    return ModnetInputGeometry::Letterbox;
  }
  return ModnetInputGeometry::Fill;
}

ModnetInputGeometry modnetInputGeometryForThisPlatform() {
#if defined(_WIN32)
  constexpr bool kIsWindows = true;
#else
  constexpr bool kIsWindows = false;
#endif
  // Read once: the kill switch is a process-level setting, and every backend
  // and code path (CPU, fp16, zero-copy, OpenVINO) must see the same value.
  static const ModnetInputGeometry geometry = modnetInputGeometryFor(
      kIsWindows, std::getenv("BROADIFY_MEETING_KEYER_LETTERBOX"));
  return geometry;
}

void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor,
                            ModnetLetterboxMapping *mappingOut,
                            ModnetInputGeometry geometry) {
  tensor.assign(static_cast<size_t>(3u) * inputWidth * inputHeight, 0.0f);
  // The block-average loop below maps x and y independently, so a Fill
  // mapping (content = the whole tensor) reuses it. A source extent smaller
  // than the content extent (upscale) yields empty blocks: Letterbox keeps
  // writing them as normalized mid-grey (unchanged behavior), Fill widens
  // them to the nearest source pixel (clampFillBlockBounds), so a stretched
  // frame never contains padding values.
  const ModnetLetterboxMapping mapping = modnetInputMapping(
      input.width, input.height, inputWidth, inputHeight, geometry);
  if (mappingOut != nullptr) {
    *mappingOut = mapping;
  }
  if (mapping.contentWidth == 0u || mapping.contentHeight == 0u) {
    return;
  }
  const size_t channelSize = static_cast<size_t>(inputWidth) * inputHeight;
  const bool fill = mapping.geometry == ModnetInputGeometry::Fill;
  for (uint32_t y = 0; y < mapping.contentHeight; ++y) {
    uint32_t srcTop = static_cast<uint32_t>(
        (static_cast<uint64_t>(y) * input.height) / mapping.contentHeight);
    uint32_t srcBottom = static_cast<uint32_t>(
        (static_cast<uint64_t>(y + 1u) * input.height) /
        mapping.contentHeight);
    if (fill) {
      clampFillBlockBounds(srcTop, srcBottom, input.height);
    }
    const uint32_t dstY = mapping.contentY + y;
    for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
      uint32_t srcLeft = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * input.width) / mapping.contentWidth);
      uint32_t srcRight = static_cast<uint32_t>(
          (static_cast<uint64_t>(x + 1u) * input.width) /
          mapping.contentWidth);
      if (fill) {
        clampFillBlockBounds(srcLeft, srcRight, input.width);
      }
      const uint32_t dstX = mapping.contentX + x;
      const size_t dstOffset = static_cast<size_t>(dstY) * inputWidth + dstX;
      writeIntegerBlockAverage(input, srcLeft, srcTop, srcRight, srcBottom,
                               dstOffset, channelSize, tensor);
    }
  }
}

void copyModnetAlphaMask(const float *mask, uint32_t maskWidth,
                         uint32_t maskHeight,
                         const ModnetLetterboxMapping &mapping,
                         uint32_t outputWidth,
                         uint32_t outputHeight,
                         uint64_t timestampNs,
                         AlphaMask &outputMask) {
  if (mask == nullptr || maskWidth == 0u || maskHeight == 0u ||
      outputWidth == 0u || outputHeight == 0u || mapping.inputWidth == 0u ||
      mapping.inputHeight == 0u || mapping.contentWidth == 0u ||
      mapping.contentHeight == 0u) {
    return;
  }
  if (mapping.geometry == ModnetInputGeometry::Fill) {
    copyFilledModnetAlphaMask(mask, maskWidth, maskHeight, mapping,
                              timestampNs, outputMask);
    return;
  }
  const uint32_t cropX =
      std::min(scaledCropCoord(mapping.contentX, mapping.inputWidth, maskWidth),
               maskWidth - 1u);
  const uint32_t cropY =
      std::min(scaledCropCoord(mapping.contentY, mapping.inputHeight, maskHeight),
               maskHeight - 1u);
  uint32_t cropWidth = scaledCropCoord(mapping.contentWidth, mapping.inputWidth,
                                       maskWidth);
  uint32_t cropHeight = scaledCropCoord(mapping.contentHeight, mapping.inputHeight,
                                        maskHeight);
  cropWidth = std::max(1u, std::min(cropWidth, maskWidth - cropX));
  cropHeight = std::max(1u, std::min(cropHeight, maskHeight - cropY));

  (void)outputWidth;
  (void)outputHeight;
  outputMask.width = cropWidth;
  outputMask.height = cropHeight;
  outputMask.timestampNs = timestampNs;
  outputMask.alpha.assign(static_cast<size_t>(cropWidth) * cropHeight, 0u);
  for (uint32_t y = 0; y < cropHeight; ++y) {
    for (uint32_t x = 0; x < cropWidth; ++x) {
      const size_t offset = static_cast<size_t>(y) * cropWidth + x;
      const float alpha = std::clamp(
          mask[static_cast<size_t>(cropY + y) * maskWidth + cropX + x],
          0.0f, 1.0f);
      outputMask.alpha[offset] =
          static_cast<uint8_t>(std::round(alpha * 255.0f));
    }
  }
}

}  // namespace broadify::meeting
