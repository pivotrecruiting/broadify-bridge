#include "keyer/matting_common.h"

#include <algorithm>
#include <cmath>
#include <cstddef>

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
  return mapping;
}

void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor,
                            ModnetLetterboxMapping *mappingOut) {
  tensor.assign(static_cast<size_t>(3u) * inputWidth * inputHeight, 0.0f);
  const ModnetLetterboxMapping mapping = modnetLetterboxMapping(
      input.width, input.height, inputWidth, inputHeight);
  if (mappingOut != nullptr) {
    *mappingOut = mapping;
  }
  if (mapping.contentWidth == 0u || mapping.contentHeight == 0u) {
    return;
  }
  const size_t channelSize = static_cast<size_t>(inputWidth) * inputHeight;
  for (uint32_t y = 0; y < mapping.contentHeight; ++y) {
    const uint32_t srcTop = static_cast<uint32_t>(
        (static_cast<uint64_t>(y) * input.height) / mapping.contentHeight);
    const uint32_t srcBottom = static_cast<uint32_t>(
        (static_cast<uint64_t>(y + 1u) * input.height) /
        mapping.contentHeight);
    const uint32_t dstY = mapping.contentY + y;
    for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
      const uint32_t srcLeft = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * input.width) / mapping.contentWidth);
      const uint32_t srcRight = static_cast<uint32_t>(
          (static_cast<uint64_t>(x + 1u) * input.width) /
          mapping.contentWidth);
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
