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

float boxAverageChannel(const VideoFrame &input,
                        double left,
                        double top,
                        double right,
                        double bottom,
                        uint32_t channel) {
  if (input.rgba.empty() || input.width == 0u || input.height == 0u ||
      right <= left || bottom <= top) {
    return 0.5f;
  }

  const int xStart = std::max(0, static_cast<int>(std::floor(left)));
  const int yStart = std::max(0, static_cast<int>(std::floor(top)));
  const int xEnd = std::min(static_cast<int>(input.width),
                            static_cast<int>(std::ceil(right)));
  const int yEnd = std::min(static_cast<int>(input.height),
                            static_cast<int>(std::ceil(bottom)));
  double weightedSum = 0.0;
  double weightTotal = 0.0;
  for (int y = yStart; y < yEnd; ++y) {
    const double yWeight =
        std::max(0.0, std::min(bottom, static_cast<double>(y + 1)) -
                          std::max(top, static_cast<double>(y)));
    if (yWeight <= 0.0) {
      continue;
    }
    for (int x = xStart; x < xEnd; ++x) {
      const double xWeight =
          std::max(0.0, std::min(right, static_cast<double>(x + 1)) -
                            std::max(left, static_cast<double>(x)));
      const double weight = xWeight * yWeight;
      if (weight <= 0.0) {
        continue;
      }
      const size_t offset =
          (static_cast<size_t>(y) * input.width + static_cast<size_t>(x)) * 4u +
          channel;
      weightedSum += static_cast<double>(input.rgba[offset]) * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal <= 0.0) {
    return 0.5f;
  }
  return static_cast<float>((weightedSum / weightTotal) / 255.0);
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

float sampleBilinearCrop(const float *mask,
                         uint32_t maskWidth,
                         uint32_t maskHeight,
                         uint32_t cropX,
                         uint32_t cropY,
                         uint32_t cropWidth,
                         uint32_t cropHeight,
                         uint32_t outX,
                         uint32_t outY,
                         uint32_t outputWidth,
                         uint32_t outputHeight) {
  if (cropWidth == 0u || cropHeight == 0u) {
    return 0.0f;
  }
  const double srcX = outputWidth <= 1u || cropWidth <= 1u
                          ? 0.0
                          : (static_cast<double>(outX) + 0.5) *
                                    static_cast<double>(cropWidth) /
                                    static_cast<double>(outputWidth) -
                                0.5;
  const double srcY = outputHeight <= 1u || cropHeight <= 1u
                          ? 0.0
                          : (static_cast<double>(outY) + 0.5) *
                                    static_cast<double>(cropHeight) /
                                    static_cast<double>(outputHeight) -
                                0.5;
  const int x0Local =
      std::clamp(static_cast<int>(std::floor(srcX)), 0,
                 static_cast<int>(cropWidth) - 1);
  const int y0Local =
      std::clamp(static_cast<int>(std::floor(srcY)), 0,
                 static_cast<int>(cropHeight) - 1);
  const uint32_t x0 = cropX + static_cast<uint32_t>(x0Local);
  const uint32_t y0 = cropY + static_cast<uint32_t>(y0Local);
  const uint32_t x1 = std::min(
      cropX + static_cast<uint32_t>(x0Local + 1), cropX + cropWidth - 1u);
  const uint32_t y1 = std::min(
      cropY + static_cast<uint32_t>(y0Local + 1), cropY + cropHeight - 1u);
  const double wx = std::clamp(srcX - static_cast<double>(x0Local), 0.0, 1.0);
  const double wy = std::clamp(srcY - static_cast<double>(y0Local), 0.0, 1.0);
  const double topValue =
      static_cast<double>(mask[static_cast<size_t>(y0) * maskWidth + x0]) *
          (1.0 - wx) +
      static_cast<double>(mask[static_cast<size_t>(y0) * maskWidth + x1]) * wx;
  const double bottomValue =
      static_cast<double>(mask[static_cast<size_t>(y1) * maskWidth + x0]) *
          (1.0 - wx) +
      static_cast<double>(mask[static_cast<size_t>(y1) * maskWidth + x1]) * wx;
  return static_cast<float>(topValue * (1.0 - wy) + bottomValue * wy);
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
    const double srcTop =
        static_cast<double>(y) * static_cast<double>(input.height) /
        static_cast<double>(mapping.contentHeight);
    const double srcBottom =
        static_cast<double>(y + 1u) * static_cast<double>(input.height) /
        static_cast<double>(mapping.contentHeight);
    const uint32_t dstY = mapping.contentY + y;
    for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
      const double srcLeft =
          static_cast<double>(x) * static_cast<double>(input.width) /
          static_cast<double>(mapping.contentWidth);
      const double srcRight =
          static_cast<double>(x + 1u) * static_cast<double>(input.width) /
          static_cast<double>(mapping.contentWidth);
      const uint32_t dstX = mapping.contentX + x;
      const size_t dstOffset = static_cast<size_t>(dstY) * inputWidth + dstX;
      tensor[dstOffset] =
          normalized(boxAverageChannel(input, srcLeft, srcTop, srcRight,
                                       srcBottom, 0u));
      tensor[channelSize + dstOffset] =
          normalized(boxAverageChannel(input, srcLeft, srcTop, srcRight,
                                       srcBottom, 1u));
      tensor[channelSize * 2u + dstOffset] =
          normalized(boxAverageChannel(input, srcLeft, srcTop, srcRight,
                                       srcBottom, 2u));
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

  outputMask.width = outputWidth;
  outputMask.height = outputHeight;
  outputMask.timestampNs = timestampNs;
  outputMask.alpha.assign(static_cast<size_t>(outputWidth) * outputHeight, 0u);
  for (uint32_t y = 0; y < outputHeight; ++y) {
    for (uint32_t x = 0; x < outputWidth; ++x) {
      const size_t offset = static_cast<size_t>(y) * outputWidth + x;
      const float alpha = std::clamp(
          sampleBilinearCrop(mask, maskWidth, maskHeight, cropX, cropY,
                             cropWidth, cropHeight, x, y, outputWidth,
                             outputHeight),
          0.0f, 1.0f);
      outputMask.alpha[offset] =
          static_cast<uint8_t>(std::round(alpha * 255.0f));
    }
  }
}

}  // namespace broadify::meeting
