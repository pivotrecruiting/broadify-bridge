#pragma once

#include <cstddef>
#include <cstdint>

namespace broadify::meeting {

// The virtual camera (macOS CMIO extension, Windows service ring and DLL) is a
// 16:9-only sink: its media type and the shared-memory layout limits are fixed
// to landscape frames up to 1920x1080.
constexpr uint32_t kVcamPortraitFitWidth = 1920u;
constexpr uint32_t kVcamPortraitFitHeight = 1080u;

struct FrameGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
};

struct FitRect {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

// Frame size the virtual camera receives for a program canvas. Landscape and
// square canvases pass through unchanged; a portrait canvas (height > width)
// is delivered pillarboxed inside 1920x1080.
FrameGeometry vcamOutputGeometry(uint32_t programWidth, uint32_t programHeight);

// Largest centered rectangle with the source aspect ratio inside the
// destination ("contain"). Rounded to whole pixels, never empty for non-empty
// inputs; all zero when any input dimension is zero.
FitRect containRect(uint32_t sourceWidth,
                    uint32_t sourceHeight,
                    uint32_t destinationWidth,
                    uint32_t destinationHeight);

// Scales a tightly-or-loosely packed RGBA frame into the contain rectangle of
// the destination and fills the remaining bars with opaque black. Identical
// sizes are a plain row copy. Strides are in bytes and must be >= width * 4.
// Returns false (destination untouched) on invalid arguments. Source and
// destination must not overlap.
//
// Uses vImage on Apple platforms and falls back to fitContainRgbaScalar.
bool fitContainRgba(const uint8_t *source,
                    uint32_t sourceWidth,
                    uint32_t sourceHeight,
                    size_t sourceStride,
                    uint8_t *destination,
                    uint32_t destinationWidth,
                    uint32_t destinationHeight,
                    size_t destinationStride);

// Portable bilinear implementation (fixed-point, no platform dependencies).
bool fitContainRgbaScalar(const uint8_t *source,
                          uint32_t sourceWidth,
                          uint32_t sourceHeight,
                          size_t sourceStride,
                          uint8_t *destination,
                          uint32_t destinationWidth,
                          uint32_t destinationHeight,
                          size_t destinationStride);

}  // namespace broadify::meeting
