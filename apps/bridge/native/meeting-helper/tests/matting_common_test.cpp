#include "keyer/matting_common.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

using broadify::meeting::AlphaMask;
using broadify::meeting::ModnetLetterboxMapping;
using broadify::meeting::VideoFrame;
using broadify::meeting::buildModnetInputTensor;
using broadify::meeting::copyModnetAlphaMask;
using broadify::meeting::modnetLetterboxMapping;

namespace {

bool expect(bool condition, const std::string &what) {
  if (!condition) {
    std::cerr << "matting_common_test failed: " << what << std::endl;
  }
  return condition;
}

float denormalize(float value) {
  return ((value * 0.5f) + 0.5f) * 255.0f;
}

uint8_t pixelValue(uint32_t x, uint32_t y, uint32_t channel) {
  return static_cast<uint8_t>(10u + channel * 40u + x * 7u + y * 29u);
}

VideoFrame makeGradientFrame(uint32_t width, uint32_t height) {
  VideoFrame frame;
  frame.width = width;
  frame.height = height;
  frame.timestampNs = 123u;
  frame.rgba.assign(static_cast<size_t>(width) * height * 4u, 255u);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const size_t offset = (static_cast<size_t>(y) * width + x) * 4u;
      frame.rgba[offset + 0u] = pixelValue(x, y, 0u);
      frame.rgba[offset + 1u] = pixelValue(x, y, 1u);
      frame.rgba[offset + 2u] = pixelValue(x, y, 2u);
    }
  }
  return frame;
}

double referenceBox(const VideoFrame &frame,
                    double left,
                    double top,
                    double right,
                    double bottom,
                    uint32_t channel) {
  double sum = 0.0;
  double weights = 0.0;
  for (uint32_t y = 0; y < frame.height; ++y) {
    const double wy =
        std::max(0.0, std::min(bottom, static_cast<double>(y + 1u)) -
                          std::max(top, static_cast<double>(y)));
    for (uint32_t x = 0; x < frame.width; ++x) {
      const double wx =
          std::max(0.0, std::min(right, static_cast<double>(x + 1u)) -
                            std::max(left, static_cast<double>(x)));
      const double weight = wx * wy;
      if (weight <= 0.0) {
        continue;
      }
      const size_t offset =
          (static_cast<size_t>(y) * frame.width + x) * 4u + channel;
      sum += frame.rgba[offset] * weight;
      weights += weight;
    }
  }
  return weights > 0.0 ? sum / weights : 127.5;
}

}  // namespace

int main() {
  bool ok = true;

  {
    const ModnetLetterboxMapping mapping =
        modnetLetterboxMapping(1920u, 1080u, 512u, 512u);
    ok &= expect(mapping.contentX == 0u, "16:9 content has no x padding");
    ok &= expect(mapping.contentY == 112u, "16:9 content is vertically centered");
    ok &= expect(mapping.contentWidth == 512u, "16:9 content preserves width");
    ok &= expect(mapping.contentHeight == 288u, "16:9 content preserves height");

    const double sourceX = 777.25;
    const double sourceY = 312.5;
    const double modelX =
        mapping.contentX + sourceX * mapping.contentWidth / 1920.0;
    const double modelY =
        mapping.contentY + sourceY * mapping.contentHeight / 1080.0;
    const double roundTripX =
        (modelX - mapping.contentX) * 1920.0 / mapping.contentWidth;
    const double roundTripY =
        (modelY - mapping.contentY) * 1080.0 / mapping.contentHeight;
    ok &= expect(std::abs(roundTripX - sourceX) < 0.0001,
                 "letterbox x mapping round-trips");
    ok &= expect(std::abs(roundTripY - sourceY) < 0.0001,
                 "letterbox y mapping round-trips");
  }

  {
    const VideoFrame frame = makeGradientFrame(6u, 3u);
    std::vector<float> tensor;
    ModnetLetterboxMapping mapping;
    buildModnetInputTensor(frame, 4u, 4u, tensor, &mapping);
    ok &= expect(mapping.contentX == 0u && mapping.contentY == 1u &&
                     mapping.contentWidth == 4u &&
                     mapping.contentHeight == 2u,
                 "6:3 frame letterboxes into the center rows");
    const size_t channelSize = 16u;
    for (uint32_t channel = 0; channel < 3u; ++channel) {
      for (uint32_t y = 0; y < mapping.contentHeight; ++y) {
        for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
          const double left = static_cast<double>(x) * 6.0 / 4.0;
          const double right = static_cast<double>(x + 1u) * 6.0 / 4.0;
          const double top = static_cast<double>(y) * 3.0 / 2.0;
          const double bottom = static_cast<double>(y + 1u) * 3.0 / 2.0;
          const size_t offset = static_cast<size_t>(mapping.contentY + y) * 4u +
                                mapping.contentX + x + channel * channelSize;
          const double actual = denormalize(tensor[offset]);
          const double expected =
              referenceBox(frame, left, top, right, bottom, channel);
          ok &= expect(std::abs(actual - expected) < 0.01,
                       "box downsample matches reference");
        }
      }
    }
    ok &= expect(tensor[0] == 0.0f && tensor[channelSize - 1u] == 0.0f,
                 "letterbox padding is normalized zero");
  }

  {
    const ModnetLetterboxMapping mapping =
        modnetLetterboxMapping(16u, 8u, 8u, 8u);
    std::vector<float> modelMask(64u, 1.0f);
    for (uint32_t y = 0; y < mapping.contentHeight; ++y) {
      for (uint32_t x = 0; x < mapping.contentWidth; ++x) {
        modelMask[static_cast<size_t>(mapping.contentY + y) * 8u +
                  mapping.contentX + x] = 0.25f;
      }
    }
    AlphaMask output;
    copyModnetAlphaMask(modelMask.data(), 8u, 8u, mapping, 16u, 8u, 99u,
                        output);
    ok &= expect(output.width == 16u && output.height == 8u,
                 "alpha readback resamples to working dimensions");
    ok &= expect(output.timestampNs == 99u, "alpha readback keeps timestamp");
    for (const uint8_t alpha : output.alpha) {
      ok &= expect(alpha == 64u,
                   "alpha readback crops away letterbox padding before upscale");
      if (!ok) {
        break;
      }
    }
  }

  if (!ok) {
    return 1;
  }
  std::cout << "matting_common_test passed" << std::endl;
  return 0;
}
