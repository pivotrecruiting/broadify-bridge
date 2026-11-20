#include "util/frame_fit.h"

#if defined(__APPLE__)
#include <Accelerate/Accelerate.h>
#endif

#include <algorithm>
#include <cstring>
#include <vector>

namespace broadify::meeting {
namespace {

bool validFitArguments(const uint8_t *source,
                       uint32_t sourceWidth,
                       uint32_t sourceHeight,
                       size_t sourceStride,
                       const uint8_t *destination,
                       uint32_t destinationWidth,
                       uint32_t destinationHeight,
                       size_t destinationStride) {
  return source != nullptr && destination != nullptr && sourceWidth > 0u &&
         sourceHeight > 0u && destinationWidth > 0u &&
         destinationHeight > 0u &&
         sourceStride >= static_cast<size_t>(sourceWidth) * 4u &&
         destinationStride >= static_cast<size_t>(destinationWidth) * 4u;
}

void fillOpaqueBlack(uint8_t *row, uint32_t pixelCount) {
  // memcpy of a constant pixel: alignment-safe and vectorised by the compiler.
  static const uint8_t kOpaqueBlack[4] = {0u, 0u, 0u, 255u};
  for (uint32_t x = 0; x < pixelCount; ++x) {
    std::memcpy(row + static_cast<size_t>(x) * 4u, kOpaqueBlack, 4u);
  }
}

// Opaque black everywhere outside `rect`; pixels inside are left untouched.
void fillBars(uint8_t *destination,
              uint32_t destinationWidth,
              uint32_t destinationHeight,
              size_t destinationStride,
              const FitRect &rect) {
  for (uint32_t y = 0; y < destinationHeight; ++y) {
    uint8_t *row = destination + static_cast<size_t>(y) * destinationStride;
    if (y < rect.y || y >= rect.y + rect.height) {
      fillOpaqueBlack(row, destinationWidth);
      continue;
    }
    fillOpaqueBlack(row, rect.x);
    const uint32_t right = rect.x + rect.width;
    fillOpaqueBlack(row + static_cast<size_t>(right) * 4u,
                    destinationWidth - right);
  }
}

void copyRows(const uint8_t *source,
              size_t sourceStride,
              uint8_t *destination,
              size_t destinationStride,
              uint32_t width,
              uint32_t height) {
  const size_t rowBytes = static_cast<size_t>(width) * 4u;
  for (uint32_t y = 0; y < height; ++y) {
    std::memcpy(destination + static_cast<size_t>(y) * destinationStride,
                source + static_cast<size_t>(y) * sourceStride, rowBytes);
  }
}

// One bilinear tap pair along an axis: the two source indices and the weight
// of the second one in 1/256 steps (pixel-center mapping, edges clamped).
struct AxisTap {
  uint32_t index0 = 0;
  uint32_t index1 = 0;
  uint32_t weight1 = 0;
};

AxisTap axisTap(uint32_t destinationIndex,
                uint32_t destinationSize,
                uint32_t sourceSize) {
  // Source position of the destination pixel center in 1/256 source pixels:
  // (d + 0.5) * source / destination - 0.5.
  const int64_t position =
      ((static_cast<int64_t>(destinationIndex) * 2 + 1) *
       static_cast<int64_t>(sourceSize) * 256) /
          (static_cast<int64_t>(destinationSize) * 2) -
      128;
  AxisTap tap;
  if (position <= 0) {
    return tap;
  }
  const uint32_t last = sourceSize - 1u;
  const uint32_t index = static_cast<uint32_t>(position >> 8);
  if (index >= last) {
    tap.index0 = last;
    tap.index1 = last;
    return tap;
  }
  tap.index0 = index;
  tap.index1 = index + 1u;
  tap.weight1 = static_cast<uint32_t>(position & 0xff);
  return tap;
}

void scaleBilinearScalar(const uint8_t *source,
                         uint32_t sourceWidth,
                         uint32_t sourceHeight,
                         size_t sourceStride,
                         uint8_t *destination,
                         size_t destinationStride,
                         const FitRect &rect) {
  std::vector<AxisTap> columns(rect.width);
  for (uint32_t x = 0; x < rect.width; ++x) {
    columns[x] = axisTap(x, rect.width, sourceWidth);
  }
  for (uint32_t y = 0; y < rect.height; ++y) {
    const AxisTap rowTap = axisTap(y, rect.height, sourceHeight);
    const uint8_t *row0 =
        source + static_cast<size_t>(rowTap.index0) * sourceStride;
    const uint8_t *row1 =
        source + static_cast<size_t>(rowTap.index1) * sourceStride;
    const uint32_t wy1 = rowTap.weight1;
    const uint32_t wy0 = 256u - wy1;
    uint8_t *out = destination +
                   static_cast<size_t>(rect.y + y) * destinationStride +
                   static_cast<size_t>(rect.x) * 4u;
    for (uint32_t x = 0; x < rect.width; ++x) {
      const AxisTap &column = columns[x];
      const uint32_t wx1 = column.weight1;
      const uint32_t wx0 = 256u - wx1;
      const uint8_t *p00 = row0 + static_cast<size_t>(column.index0) * 4u;
      const uint8_t *p01 = row0 + static_cast<size_t>(column.index1) * 4u;
      const uint8_t *p10 = row1 + static_cast<size_t>(column.index0) * 4u;
      const uint8_t *p11 = row1 + static_cast<size_t>(column.index1) * 4u;
      for (uint32_t channel = 0; channel < 4u; ++channel) {
        const uint32_t top = p00[channel] * wx0 + p01[channel] * wx1;
        const uint32_t bottom = p10[channel] * wx0 + p11[channel] * wx1;
        out[channel] =
            static_cast<uint8_t>((top * wy0 + bottom * wy1 + 32768u) >> 16);
      }
      out += 4;
    }
  }
}

}  // namespace

FrameGeometry vcamOutputGeometry(uint32_t programWidth,
                                 uint32_t programHeight) {
  if (programHeight > programWidth) {
    return FrameGeometry{kVcamPortraitFitWidth, kVcamPortraitFitHeight};
  }
  return FrameGeometry{programWidth, programHeight};
}

FitRect containRect(uint32_t sourceWidth,
                    uint32_t sourceHeight,
                    uint32_t destinationWidth,
                    uint32_t destinationHeight) {
  if (sourceWidth == 0u || sourceHeight == 0u || destinationWidth == 0u ||
      destinationHeight == 0u) {
    return FitRect{};
  }
  const uint64_t sw = sourceWidth;
  const uint64_t sh = sourceHeight;
  const uint64_t dw = destinationWidth;
  const uint64_t dh = destinationHeight;
  FitRect rect;
  if (sw * dh <= dw * sh) {
    // Source is narrower than the destination: full height, bars left/right.
    rect.height = destinationHeight;
    rect.width = static_cast<uint32_t>(std::clamp<uint64_t>(
        (sw * dh + sh / 2u) / sh, 1u, dw));
  } else {
    // Source is wider: full width, bars top/bottom.
    rect.width = destinationWidth;
    rect.height = static_cast<uint32_t>(std::clamp<uint64_t>(
        (sh * dw + sw / 2u) / sw, 1u, dh));
  }
  rect.x = (destinationWidth - rect.width) / 2u;
  rect.y = (destinationHeight - rect.height) / 2u;
  return rect;
}

bool fitContainRgbaScalar(const uint8_t *source,
                          uint32_t sourceWidth,
                          uint32_t sourceHeight,
                          size_t sourceStride,
                          uint8_t *destination,
                          uint32_t destinationWidth,
                          uint32_t destinationHeight,
                          size_t destinationStride) {
  if (!validFitArguments(source, sourceWidth, sourceHeight, sourceStride,
                         destination, destinationWidth, destinationHeight,
                         destinationStride)) {
    return false;
  }
  if (sourceWidth == destinationWidth && sourceHeight == destinationHeight) {
    copyRows(source, sourceStride, destination, destinationStride, sourceWidth,
             sourceHeight);
    return true;
  }
  const FitRect rect = containRect(sourceWidth, sourceHeight, destinationWidth,
                                   destinationHeight);
  fillBars(destination, destinationWidth, destinationHeight, destinationStride,
           rect);
  scaleBilinearScalar(source, sourceWidth, sourceHeight, sourceStride,
                      destination, destinationStride, rect);
  return true;
}

bool fitContainRgba(const uint8_t *source,
                    uint32_t sourceWidth,
                    uint32_t sourceHeight,
                    size_t sourceStride,
                    uint8_t *destination,
                    uint32_t destinationWidth,
                    uint32_t destinationHeight,
                    size_t destinationStride) {
#if defined(__APPLE__)
  if (validFitArguments(source, sourceWidth, sourceHeight, sourceStride,
                        destination, destinationWidth, destinationHeight,
                        destinationStride) &&
      !(sourceWidth == destinationWidth && sourceHeight == destinationHeight)) {
    const FitRect rect = containRect(sourceWidth, sourceHeight,
                                     destinationWidth, destinationHeight);
    vImage_Buffer sourceBuffer;
    sourceBuffer.data = const_cast<uint8_t *>(source);
    sourceBuffer.width = sourceWidth;
    sourceBuffer.height = sourceHeight;
    sourceBuffer.rowBytes = sourceStride;
    vImage_Buffer destinationBuffer;
    destinationBuffer.data = destination +
                             static_cast<size_t>(rect.y) * destinationStride +
                             static_cast<size_t>(rect.x) * 4u;
    destinationBuffer.width = rect.width;
    destinationBuffer.height = rect.height;
    destinationBuffer.rowBytes = destinationStride;
    // Channel order does not matter for scaling; all four are resampled alike.
    if (vImageScale_ARGB8888(&sourceBuffer, &destinationBuffer, nullptr,
                             kvImageNoFlags) == kvImageNoError) {
      fillBars(destination, destinationWidth, destinationHeight,
               destinationStride, rect);
      return true;
    }
  }
#endif
  return fitContainRgbaScalar(source, sourceWidth, sourceHeight, sourceStride,
                              destination, destinationWidth, destinationHeight,
                              destinationStride);
}

}  // namespace broadify::meeting
