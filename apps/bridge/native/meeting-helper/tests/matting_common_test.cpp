#include "keyer/matting_common.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using broadify::meeting::AlphaMask;
using broadify::meeting::ModnetInputGeometry;
using broadify::meeting::ModnetLetterboxMapping;
using broadify::meeting::VideoFrame;
using broadify::meeting::buildModnetInputTensor;
using broadify::meeting::copyModnetAlphaMask;
using broadify::meeting::modnetFillMapping;
using broadify::meeting::modnetInputGeometryFor;
using broadify::meeting::modnetInputGeometryForThisPlatform;
using broadify::meeting::modnetInputMapping;
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

double referenceIntegerBox(const VideoFrame &frame,
                           uint32_t left,
                           uint32_t top,
                           uint32_t right,
                           uint32_t bottom,
                           uint32_t channel) {
  uint64_t sum = 0u;
  uint64_t count = 0u;
  for (uint32_t y = top; y < bottom; ++y) {
    for (uint32_t x = left; x < right; ++x) {
      const size_t offset =
          (static_cast<size_t>(y) * frame.width + x) * 4u + channel;
      sum += frame.rgba[offset];
      ++count;
    }
  }
  return count > 0u ? static_cast<double>(sum) / static_cast<double>(count)
                    : 127.5;
}

// 8x4 frame whose 2x1 blocks (columns 2bx..2bx+1, one row) all have distinct
// colours and two slightly different pixels, and none averages to mid-grey
// 127.5 (the normalized-0.0 padding value).
uint8_t blockPixelValue(uint32_t x, uint32_t y, uint32_t channel) {
  const uint32_t block = x / 2u;
  const uint32_t odd = x % 2u;
  if (channel == 0u) {
    return static_cast<uint8_t>(20u + 50u * block + 3u * odd + 10u * y);
  }
  if (channel == 1u) {
    return static_cast<uint8_t>(200u - 40u * block - 7u * y + 2u * odd);
  }
  return static_cast<uint8_t>(60u + 30u * y + 20u * block + odd);
}

VideoFrame makeBlockFrame() {
  VideoFrame frame;
  frame.width = 8u;
  frame.height = 4u;
  frame.timestampNs = 7u;
  frame.rgba.assign(static_cast<size_t>(8u) * 4u * 4u, 255u);
  for (uint32_t y = 0; y < 4u; ++y) {
    for (uint32_t x = 0; x < 8u; ++x) {
      const size_t offset = (static_cast<size_t>(y) * 8u + x) * 4u;
      frame.rgba[offset + 0u] = blockPixelValue(x, y, 0u);
      frame.rgba[offset + 1u] = blockPixelValue(x, y, 1u);
      frame.rgba[offset + 2u] = blockPixelValue(x, y, 2u);
    }
  }
  return frame;
}

// Small frame from explicit per-pixel RGB triples (row-major, alpha 255).
VideoFrame makeFrame(uint32_t width, uint32_t height,
                     const std::vector<uint8_t> &rgb) {
  VideoFrame frame;
  frame.width = width;
  frame.height = height;
  frame.rgba.assign(static_cast<size_t>(width) * height * 4u, 255u);
  for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) {
    frame.rgba[i * 4u + 0u] = rgb[i * 3u + 0u];
    frame.rgba[i * 4u + 1u] = rgb[i * 3u + 1u];
    frame.rgba[i * 4u + 2u] = rgb[i * 3u + 2u];
  }
  return frame;
}

double normalizedByte(double value) {
  return (value / 255.0 - 0.5) / 0.5;
}

bool sameMapping(const ModnetLetterboxMapping &a,
                 const ModnetLetterboxMapping &b) {
  return a.inputWidth == b.inputWidth && a.inputHeight == b.inputHeight &&
         a.contentX == b.contentX && a.contentY == b.contentY &&
         a.contentWidth == b.contentWidth &&
         a.contentHeight == b.contentHeight && a.geometry == b.geometry &&
         a.maskOutputWidth == b.maskOutputWidth &&
         a.maskOutputHeight == b.maskOutputHeight;
}

bool isEmptyContent(const ModnetLetterboxMapping &mapping) {
  return mapping.contentX == 0u && mapping.contentY == 0u &&
         mapping.contentWidth == 0u && mapping.contentHeight == 0u &&
         mapping.maskOutputWidth == 0u && mapping.maskOutputHeight == 0u;
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
          const uint32_t left = (x * 6u) / 4u;
          const uint32_t right = ((x + 1u) * 6u) / 4u;
          const uint32_t top = (y * 3u) / 2u;
          const uint32_t bottom = ((y + 1u) * 3u) / 2u;
          const size_t offset = static_cast<size_t>(mapping.contentY + y) * 4u +
                                mapping.contentX + x + channel * channelSize;
          const double actual = denormalize(tensor[offset]);
          const double expected =
              referenceIntegerBox(frame, left, top, right, bottom, channel);
          ok &= expect(std::abs(actual - expected) < 0.01,
                       "integer block downsample matches reference");
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
    ok &= expect(output.width == 8u && output.height == 4u,
                 "alpha readback emits the model-resolution content crop");
    ok &= expect(output.timestampNs == 99u, "alpha readback keeps timestamp");
    for (const uint8_t alpha : output.alpha) {
      ok &= expect(alpha == 64u,
                   "alpha readback crops away letterbox padding before upscale");
      if (!ok) {
        break;
      }
    }
  }

  {
    // Letterbox mappings report the emitted mask size = content size.
    const ModnetLetterboxMapping mapping =
        modnetLetterboxMapping(1920u, 1080u, 512u, 512u);
    ok &= expect(mapping.geometry == ModnetInputGeometry::Letterbox,
                 "letterbox mapping reports letterbox geometry");
    ok &= expect(mapping.maskOutputWidth == mapping.contentWidth &&
                     mapping.maskOutputHeight == mapping.contentHeight,
                 "letterbox mask output equals the content size");
    ok &= expect(sameMapping(modnetInputMapping(1920u, 1080u, 512u, 512u,
                                                ModnetInputGeometry::Letterbox),
                             mapping),
                 "input mapping dispatches to the letterbox mapping");
  }

  {
    // Fill mappings cover the whole tensor and keep today's mask size for
    // every Windows tier.
    const uint32_t sizes[3] = {512u, 320u, 256u};
    const uint32_t expectedHeights[3] = {288u, 180u, 144u};
    for (size_t i = 0; i < 3u; ++i) {
      const uint32_t size = sizes[i];
      const ModnetLetterboxMapping fill =
          modnetFillMapping(1920u, 1080u, size, size);
      const ModnetLetterboxMapping letterbox =
          modnetLetterboxMapping(1920u, 1080u, size, size);
      const std::string label = "fill " + std::to_string(size) + ": ";
      ok &= expect(fill.geometry == ModnetInputGeometry::Fill,
                   label + "geometry is fill");
      ok &= expect(fill.inputWidth == size && fill.inputHeight == size,
                   label + "input size kept");
      ok &= expect(fill.contentX == 0u && fill.contentY == 0u &&
                       fill.contentWidth == size && fill.contentHeight == size,
                   label + "content covers the whole tensor");
      ok &= expect(fill.maskOutputWidth == size &&
                       fill.maskOutputHeight == expectedHeights[i],
                   label + "mask output keeps the 16:9 letterbox size");
      ok &= expect(fill.maskOutputWidth == letterbox.contentWidth &&
                       fill.maskOutputHeight == letterbox.contentHeight,
                   label + "mask output equals the letterbox content size");
      ok &= expect(sameMapping(modnetInputMapping(1920u, 1080u, size, size,
                                                  ModnetInputGeometry::Fill),
                               fill),
                   label + "input mapping dispatches to the fill mapping");
    }

    const ModnetLetterboxMapping zeroSource =
        modnetFillMapping(0u, 1080u, 512u, 512u);
    ok &= expect(isEmptyContent(zeroSource) &&
                     isEmptyContent(modnetLetterboxMapping(0u, 1080u, 512u,
                                                           512u)),
                 "fill mapping of a zero-width source is empty");
    ok &= expect(isEmptyContent(modnetFillMapping(1920u, 0u, 512u, 512u)),
                 "fill mapping of a zero-height source is empty");
    ok &= expect(isEmptyContent(modnetFillMapping(1920u, 1080u, 0u, 512u)) &&
                     isEmptyContent(modnetFillMapping(1920u, 1080u, 512u, 0u)),
                 "fill mapping of a zero-size tensor is empty");
  }

  {
    // Portrait source: Fill keeps the letterbox content width as mask output
    // (1080x1920 at 512 -> 288x512), and the readback emits exactly that.
    const ModnetLetterboxMapping fill = modnetFillMapping(1080u, 1920u, 512u, 512u);
    const ModnetLetterboxMapping letterbox =
        modnetLetterboxMapping(1080u, 1920u, 512u, 512u);
    ok &= expect(letterbox.contentWidth == 288u && letterbox.contentHeight == 512u,
                 "portrait letterbox content is 288x512");
    ok &= expect(fill.contentX == 0u && fill.contentY == 0u &&
                     fill.contentWidth == 512u && fill.contentHeight == 512u &&
                     fill.maskOutputWidth == 288u &&
                     fill.maskOutputHeight == 512u,
                 "portrait fill mapping keeps a 288x512 mask output");
    // Left half 0, right half 1: the 512 -> 288 x resample keeps both edges.
    std::vector<float> modelMask(static_cast<size_t>(512u) * 512u, 0.0f);
    for (uint32_t y = 0; y < 512u; ++y) {
      for (uint32_t x = 256u; x < 512u; ++x) {
        modelMask[static_cast<size_t>(y) * 512u + x] = 1.0f;
      }
    }
    AlphaMask output;
    copyModnetAlphaMask(modelMask.data(), 512u, 512u, fill, 1080u, 1920u, 4u,
                        output);
    ok &= expect(output.width == 288u && output.height == 512u &&
                     output.alpha.size() == static_cast<size_t>(288u) * 512u,
                 "portrait fill readback emits 288x512");
    if (output.alpha.size() == static_cast<size_t>(288u) * 512u) {
      ok &= expect(output.alpha[0] == 0u && output.alpha[287] == 255u &&
                       output.alpha[static_cast<size_t>(511u) * 288u] == 0u &&
                       output.alpha[static_cast<size_t>(511u) * 288u + 287u] ==
                           255u,
                   "portrait fill readback keeps the left/right halves");
    }
  }

  {
    // Fill tensor: the 8x4 frame is stretched over the full 4x4 tensor, every
    // element is the normalized average of its 2x1 source block.
    const VideoFrame frame = makeBlockFrame();
    std::vector<float> tensor;
    ModnetLetterboxMapping mapping;
    buildModnetInputTensor(frame, 4u, 4u, tensor, &mapping,
                           ModnetInputGeometry::Fill);
    ok &= expect(mapping.geometry == ModnetInputGeometry::Fill &&
                     mapping.contentX == 0u && mapping.contentY == 0u &&
                     mapping.contentWidth == 4u && mapping.contentHeight == 4u &&
                     mapping.maskOutputWidth == 4u &&
                     mapping.maskOutputHeight == 2u,
                 "fill tensor reports the fill mapping");
    ok &= expect(tensor.size() == 48u, "fill tensor keeps the NCHW shape");
    const size_t channelSize = 16u;
    for (uint32_t channel = 0; channel < 3u && tensor.size() == 48u;
         ++channel) {
      for (uint32_t y = 0; y < 4u; ++y) {
        for (uint32_t x = 0; x < 4u; ++x) {
          const double average =
              (static_cast<double>(blockPixelValue(2u * x, y, channel)) +
               static_cast<double>(blockPixelValue(2u * x + 1u, y, channel))) /
              2.0;
          const double expected = (average / 255.0 - 0.5) / 0.5;
          const float actual =
              tensor[channel * channelSize + static_cast<size_t>(y) * 4u + x];
          ok &= expect(std::abs(static_cast<double>(actual) - expected) < 1e-5,
                       "fill tensor element is its stretched block average");
          ok &= expect(average != 127.5 && actual != 0.0f,
                       "fill tensor has no padding element");
        }
      }
    }
  }

  {
    // Fill upscale: a 4x2 source stretched to 4x4. x is 1:1; y blocks are
    // [y*2/4, (y+1)*2/4) = [0,0) [0,1) [1,1) [1,2), and the shader's bounds
    // rule widens the empty ones to one row: tensor rows read source rows
    // 0, 0, 1, 1. No element is padding.
    const std::vector<uint8_t> rgb = {
        10u,  245u, 30u,  60u,  195u, 90u,  110u, 145u, 170u, 160u, 95u,  230u,
        200u, 55u,  20u,  150u, 105u, 80u,  100u, 155u, 140u, 50u,  205u, 250u,
    };
    const VideoFrame frame = makeFrame(4u, 2u, rgb);
    std::vector<float> tensor;
    ModnetLetterboxMapping mapping;
    buildModnetInputTensor(frame, 4u, 4u, tensor, &mapping,
                           ModnetInputGeometry::Fill);
    ok &= expect(mapping.contentWidth == 4u && mapping.contentHeight == 4u &&
                     mapping.maskOutputWidth == 4u &&
                     mapping.maskOutputHeight == 2u,
                 "fill upscale mapping covers the tensor");
    const uint32_t expectedSourceRow[4] = {0u, 0u, 1u, 1u};
    bool rowsMatch = tensor.size() == 48u;
    bool noPadding = rowsMatch;
    for (uint32_t channel = 0; rowsMatch && channel < 3u; ++channel) {
      for (uint32_t y = 0; y < 4u; ++y) {
        for (uint32_t x = 0; x < 4u; ++x) {
          const double expected = normalizedByte(
              rgb[(static_cast<size_t>(expectedSourceRow[y]) * 4u + x) * 3u +
                  channel]);
          const float actual =
              tensor[channel * 16u + static_cast<size_t>(y) * 4u + x];
          rowsMatch &= std::abs(static_cast<double>(actual) - expected) < 1e-6;
          noPadding &= actual != 0.0f;
        }
      }
    }
    ok &= expect(rowsMatch,
                 "fill upscale samples the nearest source row (shader rule)");
    ok &= expect(noPadding, "fill upscale writes no padding value");
  }

  {
    // Fill on a camera frame shorter than the tensor (640x480 -> 512): every
    // element averages real pixels, none is mid-grey padding.
    VideoFrame frame;
    frame.width = 640u;
    frame.height = 480u;
    frame.rgba.assign(static_cast<size_t>(640u) * 480u * 4u, 10u);
    std::vector<float> tensor;
    buildModnetInputTensor(frame, 512u, 512u, tensor, nullptr,
                           ModnetInputGeometry::Fill);
    const double expected = normalizedByte(10.0);
    bool allMatch = tensor.size() == static_cast<size_t>(3u) * 512u * 512u;
    for (size_t i = 0; allMatch && i < tensor.size(); ++i) {
      allMatch = std::abs(static_cast<double>(tensor[i]) - expected) < 1e-6;
    }
    ok &= expect(allMatch, "fill 640x480 -> 512 has no grey rows");
  }

  {
    // Letterbox keeps the empty-block grey for a tiny source: 2x1 -> 4x4
    // letterboxes into content 4x2 at row 1. Content row 0 is the empty block
    // [0,0) -> grey; content row 1 reads source row 0 with x blocks
    // [0,0) [0,1) [1,1) [1,2) -> grey, p0, grey, p1. Fill on the same frame
    // widens every block instead: each row reads p0, p0, p1, p1.
    const std::vector<uint8_t> rgb = {40u, 90u, 200u, 220u, 30u, 70u};
    const VideoFrame frame = makeFrame(2u, 1u, rgb);
    std::vector<float> tensor;
    ModnetLetterboxMapping mapping;
    buildModnetInputTensor(frame, 4u, 4u, tensor, &mapping,
                           ModnetInputGeometry::Letterbox);
    ok &= expect(mapping.contentX == 0u && mapping.contentY == 1u &&
                     mapping.contentWidth == 4u && mapping.contentHeight == 2u,
                 "tiny letterbox source maps to content 4x2 at row 1");
    bool letterboxMatches = tensor.size() == 48u;
    for (uint32_t channel = 0; letterboxMatches && channel < 3u; ++channel) {
      for (uint32_t y = 0; y < 4u; ++y) {
        for (uint32_t x = 0; x < 4u; ++x) {
          double expected = 0.0;
          if (y == 2u && x == 1u) {
            expected = normalizedByte(rgb[channel]);
          } else if (y == 2u && x == 3u) {
            expected = normalizedByte(rgb[3u + channel]);
          }
          const float actual =
              tensor[channel * 16u + static_cast<size_t>(y) * 4u + x];
          letterboxMatches &=
              std::abs(static_cast<double>(actual) - expected) < 1e-6;
        }
      }
    }
    ok &= expect(letterboxMatches,
                 "letterbox keeps mid-grey for empty blocks of a tiny source");

    std::vector<float> fillTensor;
    buildModnetInputTensor(frame, 4u, 4u, fillTensor, nullptr,
                           ModnetInputGeometry::Fill);
    bool fillMatches = fillTensor.size() == 48u;
    for (uint32_t channel = 0; fillMatches && channel < 3u; ++channel) {
      for (uint32_t y = 0; y < 4u; ++y) {
        for (uint32_t x = 0; x < 4u; ++x) {
          const double expected =
              normalizedByte(rgb[(x < 2u ? 0u : 3u) + channel]);
          const float actual =
              fillTensor[channel * 16u + static_cast<size_t>(y) * 4u + x];
          fillMatches &= std::abs(static_cast<double>(actual) - expected) < 1e-6;
        }
      }
    }
    ok &= expect(fillMatches,
                 "fill widens every empty block of a tiny source");
  }

  {
    // Letterbox regression: the explicit Letterbox geometry is byte-identical
    // to the call without the new parameter.
    const VideoFrame frames[3] = {
        makeGradientFrame(6u, 3u), makeBlockFrame(),
        makeFrame(2u, 1u, {40u, 90u, 200u, 220u, 30u, 70u})};
    for (const VideoFrame &frame : frames) {
      std::vector<float> legacyTensor;
      std::vector<float> explicitTensor;
      ModnetLetterboxMapping legacyMapping;
      ModnetLetterboxMapping explicitMapping;
      buildModnetInputTensor(frame, 4u, 4u, legacyTensor, &legacyMapping);
      buildModnetInputTensor(frame, 4u, 4u, explicitTensor, &explicitMapping,
                             ModnetInputGeometry::Letterbox);
      ok &= expect(legacyTensor.size() == explicitTensor.size() &&
                       std::memcmp(legacyTensor.data(), explicitTensor.data(),
                                   legacyTensor.size() * sizeof(float)) == 0,
                   "explicit letterbox tensor is byte-identical");
      ok &= expect(sameMapping(legacyMapping, explicitMapping) &&
                       legacyMapping.geometry == ModnetInputGeometry::Letterbox,
                   "explicit letterbox mapping is identical");
    }
  }

  {
    // Fill readback, 8x4 source -> 4x4 model mask -> 4x2 emitted mask. The
    // x axis is 1:1; y samples (dst + 0.5) * 4 / 2 - 0.5 = 2 * dst + 0.5,
    // i.e. the mean of rows (0,1) and (2,3). Values are clamped after the
    // interpolation.
    const ModnetLetterboxMapping mapping = modnetFillMapping(8u, 4u, 4u, 4u);
    const std::vector<float> modelMask = {
        0.0f,  0.2f, 0.6f, 1.0f,  //
        0.4f,  0.6f, 1.0f, 1.0f,  //
        -0.6f, 0.3f, 0.5f, 0.9f,  //
        0.2f,  0.5f, 0.7f, 1.5f,  //
    };
    AlphaMask output;
    copyModnetAlphaMask(modelMask.data(), 4u, 4u, mapping, 8u, 4u, 55u,
                        output);
    const std::vector<uint8_t> expected = {
        51u, 102u, 204u, 255u,  //
        0u,  102u, 153u, 255u,  //
    };
    ok &= expect(output.width == 4u && output.height == 2u,
                 "fill readback emits the letterbox content size");
    ok &= expect(output.timestampNs == 55u, "fill readback keeps timestamp");
    ok &= expect(output.alpha == expected,
                 "fill readback matches the hand-computed bilinear values");
  }

  {
    // Fill readback with non-half weights on x (4 -> 3, y 1:1):
    // src = (dst + 0.5) * 4 / 3 - 0.5 = 1/6, 3/2, 17/6.
    ModnetLetterboxMapping mapping = modnetFillMapping(4u, 4u, 4u, 4u);
    mapping.maskOutputWidth = 3u;
    mapping.maskOutputHeight = 4u;
    std::vector<float> modelMask;
    for (uint32_t y = 0; y < 4u; ++y) {
      modelMask.push_back(0.12f);
      modelMask.push_back(0.84f);
      modelMask.push_back(0.2f);
      modelMask.push_back(0.86f);
    }
    AlphaMask output;
    copyModnetAlphaMask(modelMask.data(), 4u, 4u, mapping, 4u, 4u, 1u, output);
    // 0.12*5/6 + 0.84/6 = 0.24 -> 61; (0.84 + 0.2)/2 = 0.52 -> 133;
    // 0.2/6 + 0.86*5/6 = 0.75 -> 191.
    std::vector<uint8_t> expected;
    for (uint32_t y = 0; y < 4u; ++y) {
      expected.push_back(61u);
      expected.push_back(133u);
      expected.push_back(191u);
    }
    ok &= expect(output.width == 3u && output.height == 4u &&
                     output.alpha == expected,
                 "fill readback interpolates fractional weights");
  }

  {
    // Fill readback identity: a square source keeps a 4x4 mask, copied 1:1
    // with the same clamp + round as the letterbox branch.
    const ModnetLetterboxMapping mapping = modnetFillMapping(4u, 4u, 4u, 4u);
    ok &= expect(mapping.maskOutputWidth == 4u && mapping.maskOutputHeight == 4u,
                 "square source keeps the full mask size");
    std::vector<float> modelMask(16u);
    for (size_t i = 0; i < modelMask.size(); ++i) {
      modelMask[i] = -0.25f + 0.1f * static_cast<float>(i);
    }
    AlphaMask output;
    copyModnetAlphaMask(modelMask.data(), 4u, 4u, mapping, 4u, 4u, 2u, output);
    bool identical = output.width == 4u && output.height == 4u &&
                     output.alpha.size() == 16u;
    for (size_t i = 0; identical && i < modelMask.size(); ++i) {
      const float alpha = std::clamp(modelMask[i], 0.0f, 1.0f);
      identical = output.alpha[i] ==
                  static_cast<uint8_t>(std::round(alpha * 255.0f));
    }
    ok &= expect(identical, "fill readback copies 1:1 when sizes match");
  }

  {
    // Fill readback keeps the null/zero-dimension early returns.
    AlphaMask output;
    output.width = 9u;
    const std::vector<float> modelMask(16u, 0.5f);
    copyModnetAlphaMask(modelMask.data(), 4u, 4u,
                        modnetFillMapping(0u, 4u, 4u, 4u), 8u, 4u, 3u, output);
    copyModnetAlphaMask(nullptr, 4u, 4u, modnetFillMapping(8u, 4u, 4u, 4u), 8u,
                        4u, 3u, output);
    ok &= expect(output.width == 9u && output.alpha.empty(),
                 "fill readback leaves the mask untouched on empty input");
  }

  {
    ok &= expect(modnetInputGeometryFor(false, nullptr) ==
                     ModnetInputGeometry::Letterbox,
                 "non-windows defaults to letterbox");
    ok &= expect(modnetInputGeometryFor(false, "0") ==
                     ModnetInputGeometry::Letterbox,
                 "non-windows ignores the kill switch value");
    ok &= expect(modnetInputGeometryFor(true, nullptr) ==
                     ModnetInputGeometry::Fill,
                 "windows defaults to fill");
    ok &= expect(modnetInputGeometryFor(true, "0") == ModnetInputGeometry::Fill,
                 "windows kill switch 0 keeps fill");
    ok &= expect(modnetInputGeometryFor(true, "") == ModnetInputGeometry::Fill,
                 "windows empty kill switch keeps fill");
    ok &= expect(modnetInputGeometryFor(true, "1") ==
                     ModnetInputGeometry::Letterbox,
                 "windows kill switch 1 restores letterbox");
#if defined(_WIN32)
    const bool isWindows = true;
#else
    const bool isWindows = false;
    ok &= expect(modnetInputGeometryForThisPlatform() ==
                     ModnetInputGeometry::Letterbox,
                 "this non-windows platform uses letterbox");
#endif
    ok &= expect(modnetInputGeometryForThisPlatform() ==
                     modnetInputGeometryFor(
                         isWindows,
                         std::getenv("BROADIFY_MEETING_KEYER_LETTERBOX")),
                 "platform geometry follows the selector");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "matting_common_test passed" << std::endl;
  return 0;
}
