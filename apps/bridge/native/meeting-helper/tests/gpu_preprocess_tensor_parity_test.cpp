#include "compose/gpu_preprocess.h"
#include "keyer/matting_common.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <vector>

using broadify::meeting::ModnetLetterboxMapping;
using broadify::meeting::TensorSampleMapping;
using broadify::meeting::VideoFrame;
using broadify::meeting::buildGpuPreprocessMapping;
using broadify::meeting::buildModnetInputTensor;
using broadify::meeting::modnetLetterboxMapping;

namespace {

float normalized(double value) {
  return static_cast<float>((value / 255.0 - 0.5) / 0.5);
}

float boxAverageChannel(const VideoFrame &frame,
                        const TensorSampleMapping &sample) {
  const int xStart = static_cast<int>(std::floor(sample.srcLeft));
  const int yStart = static_cast<int>(std::floor(sample.srcTop));
  const int xEnd = static_cast<int>(std::ceil(sample.srcRight));
  const int yEnd = static_cast<int>(std::ceil(sample.srcBottom));
  double weightedSum = 0.0;
  double weightTotal = 0.0;
  for (int y = yStart; y < yEnd; ++y) {
    const double yWeight =
        std::max(0.0, std::min(sample.srcBottom, static_cast<double>(y + 1)) -
                          std::max(sample.srcTop, static_cast<double>(y)));
    for (int x = xStart; x < xEnd; ++x) {
      const double xWeight =
          std::max(0.0, std::min(sample.srcRight, static_cast<double>(x + 1)) -
                            std::max(sample.srcLeft, static_cast<double>(x)));
      const double weight = xWeight * yWeight;
      const size_t offset =
          (static_cast<size_t>(y) * frame.width + static_cast<size_t>(x)) * 4u +
          sample.channel;
      weightedSum += static_cast<double>(frame.rgba[offset]) * weight;
      weightTotal += weight;
    }
  }
  return normalized(weightedSum / weightTotal);
}

}  // namespace

int main() {
  VideoFrame frame;
  frame.width = 16u;
  frame.height = 9u;
  frame.rgba.resize(static_cast<size_t>(frame.width) * frame.height * 4u);
  for (uint32_t y = 0; y < frame.height; ++y) {
    for (uint32_t x = 0; x < frame.width; ++x) {
      const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      frame.rgba[offset] = static_cast<uint8_t>((x * 13u + y * 7u) & 0xFFu);
      frame.rgba[offset + 1u] =
          static_cast<uint8_t>((x * 5u + y * 19u) & 0xFFu);
      frame.rgba[offset + 2u] =
          static_cast<uint8_t>((x * 29u + y * 3u) & 0xFFu);
      frame.rgba[offset + 3u] = 255u;
    }
  }

  std::vector<float> cpuTensor;
  ModnetLetterboxMapping cpuMapping;
  buildModnetInputTensor(frame, 8u, 8u, cpuTensor, &cpuMapping);
  const std::vector<TensorSampleMapping> gpuMapping =
      buildGpuPreprocessMapping(frame.width, frame.height, cpuMapping);
  assert(!gpuMapping.empty());

  for (const TensorSampleMapping &sample : gpuMapping) {
    const float expected = cpuTensor[sample.tensorIndex];
    const float actual = boxAverageChannel(frame, sample);
    assert(std::abs(expected - actual) <= 1.0e-3f);
  }
  return 0;
}
