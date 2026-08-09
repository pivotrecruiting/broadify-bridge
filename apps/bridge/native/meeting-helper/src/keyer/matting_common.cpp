#include "keyer/matting_common.h"

#include <algorithm>
#include <cmath>

namespace broadify::meeting {
namespace {

// MODNet normalization constants; see the header for why these are 0.5/0.5
// and not ImageNet stats.
constexpr float kMean[3] = {0.5f, 0.5f, 0.5f};
constexpr float kStd[3] = {0.5f, 0.5f, 0.5f};

constexpr uint32_t kModnetInputHighQuality = 512u;
constexpr uint32_t kModnetInputBalanced = 320u;
constexpr uint32_t kModnetInputPerformance = 256u;

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

void buildModnetInputTensor(const VideoFrame &input, uint32_t inputWidth,
                            uint32_t inputHeight, std::vector<float> &tensor) {
  tensor.resize(static_cast<size_t>(3u) * inputWidth * inputHeight);
  const size_t channelSize = static_cast<size_t>(inputWidth) * inputHeight;
  for (uint32_t y = 0; y < inputHeight; ++y) {
    const uint32_t sy = static_cast<uint32_t>((static_cast<uint64_t>(y) * input.height) / inputHeight);
    for (uint32_t x = 0; x < inputWidth; ++x) {
      const uint32_t sx = static_cast<uint32_t>((static_cast<uint64_t>(x) * input.width) / inputWidth);
      const size_t srcOffset = (static_cast<size_t>(sy) * input.width + sx) * 4u;
      const size_t dstOffset = static_cast<size_t>(y) * inputWidth + x;
      const float r = static_cast<float>(input.rgba[srcOffset + 0u]) / 255.0f;
      const float g = static_cast<float>(input.rgba[srcOffset + 1u]) / 255.0f;
      const float b = static_cast<float>(input.rgba[srcOffset + 2u]) / 255.0f;
      tensor[dstOffset] = (r - kMean[0]) / kStd[0];
      tensor[channelSize + dstOffset] = (g - kMean[1]) / kStd[1];
      tensor[channelSize * 2u + dstOffset] = (b - kMean[2]) / kStd[2];
    }
  }
}

void copyModnetAlphaMask(const float *mask, uint32_t maskWidth,
                         uint32_t maskHeight, uint64_t timestampNs,
                         AlphaMask &outputMask) {
  if (mask == nullptr || maskWidth == 0u || maskHeight == 0u) {
    return;
  }
  outputMask.width = maskWidth;
  outputMask.height = maskHeight;
  outputMask.timestampNs = timestampNs;
  outputMask.alpha.assign(static_cast<size_t>(maskWidth) * maskHeight, 0u);
  for (uint32_t y = 0; y < maskHeight; ++y) {
    for (uint32_t x = 0; x < maskWidth; ++x) {
      const size_t offset = static_cast<size_t>(y) * maskWidth + x;
      const float alpha = std::clamp(mask[offset], 0.0f, 1.0f);
      outputMask.alpha[offset] = static_cast<uint8_t>(std::round(alpha * 255.0f));
    }
  }
}

}  // namespace broadify::meeting
