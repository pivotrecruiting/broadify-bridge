#include "compose/compositor.h"

#include <algorithm>
#include <cmath>
#include <mutex>

namespace broadify::meeting {
namespace {

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

struct SourceRect {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

uint8_t clampByte(int value) {
  return static_cast<uint8_t>(std::clamp(value, 0, 255));
}

double clamp01(double value) {
  return std::clamp(value, 0.0, 1.0);
}

void setPixel(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) {
  if (x < 0 || y < 0 || x >= static_cast<int>(width) || y >= static_cast<int>(height)) {
    return;
  }
  const size_t offset = (static_cast<size_t>(y) * width + static_cast<uint32_t>(x)) * 4u;
  frame[offset + 0] = r;
  frame[offset + 1] = g;
  frame[offset + 2] = b;
  frame[offset + 3] = a;
}

void blendPixel(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  if (x < 0 || y < 0 || x >= static_cast<int>(width) || y >= static_cast<int>(height)) {
    return;
  }
  if (a == 255u) {
    setPixel(frame, width, height, x, y, r, g, b, 255u);
    return;
  }
  const size_t offset = (static_cast<size_t>(y) * width + static_cast<uint32_t>(x)) * 4u;
  frame[offset + 0] = clampByte((r * a + frame[offset + 0] * (255 - a)) / 255);
  frame[offset + 1] = clampByte((g * a + frame[offset + 1] * (255 - a)) / 255);
  frame[offset + 2] = clampByte((b * a + frame[offset + 2] * (255 - a)) / 255);
  frame[offset + 3] = 255u;
}

void fillRect(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const Rect &rect, uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) {
  const int minX = std::max(0, rect.x);
  const int minY = std::max(0, rect.y);
  const int maxX = std::min(static_cast<int>(width), rect.x + rect.width);
  const int maxY = std::min(static_cast<int>(height), rect.y + rect.height);
  for (int y = minY; y < maxY; ++y) {
    for (int x = minX; x < maxX; ++x) {
      if (a == 255) {
        setPixel(frame, width, height, x, y, r, g, b, a);
        continue;
      }
      const size_t offset = (static_cast<size_t>(y) * width + static_cast<uint32_t>(x)) * 4u;
      frame[offset + 0] = clampByte((r * a + frame[offset + 0] * (255 - a)) / 255);
      frame[offset + 1] = clampByte((g * a + frame[offset + 1] * (255 - a)) / 255);
      frame[offset + 2] = clampByte((b * a + frame[offset + 2] * (255 - a)) / 255);
      frame[offset + 3] = 255;
    }
  }
}

void fillBackground(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const std::string &mode, uint64_t frameIndex) {
  frame.assign(static_cast<size_t>(width) * height * 4u, 255u);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      uint8_t r = 8;
      uint8_t g = 10;
      uint8_t b = 14;
      if (mode == "gradient") {
        const int wave = static_cast<int>((x + y + frameIndex) % 96u);
        r = clampByte(20 + static_cast<int>((120.0 * x) / std::max<uint32_t>(1, width)) + wave / 5);
        g = clampByte(54 + static_cast<int>((90.0 * y) / std::max<uint32_t>(1, height)));
        b = clampByte(94 + wave);
      } else if (mode == "solid_light") {
        r = 232;
        g = 236;
        b = 229;
      } else if (mode == "checkerboard") {
        const bool tile = ((x / 48u) + (y / 48u)) % 2u == 0u;
        r = tile ? 42 : 70;
        g = tile ? 45 : 74;
        b = tile ? 50 : 82;
      } else if (mode == "transparent") {
        r = 0;
        g = 0;
        b = 0;
      }
      setPixel(frame, width, height, static_cast<int>(x), static_cast<int>(y), r, g, b);
    }
  }
}

Rect cameraRect(uint32_t width, uint32_t height, const SpeakerLayoutState &speakerLayout) {
  if (!speakerLayout.enabled) {
    return {0, 0, static_cast<int>(width), static_cast<int>(height)};
  }
  const double scale = std::clamp(speakerLayout.scale, 0.4, 1.5);
  const int rectHeight = static_cast<int>(height * 0.50 * scale);
  const int rectWidth = static_cast<int>(rectHeight * 0.58);
  const int marginX = static_cast<int>(width * 0.06);
  const int marginBottom = static_cast<int>(height * 0.08);
  int x = static_cast<int>(width) - rectWidth - marginX;
  if (speakerLayout.layout == "left") {
    x = marginX;
  } else if (speakerLayout.layout == "center") {
    x = (static_cast<int>(width) - rectWidth) / 2;
  }
  return {x, static_cast<int>(height) - rectHeight - marginBottom, rectWidth, rectHeight};
}

SourceRect coverSourceRect(uint32_t sourceWidth, uint32_t sourceHeight, int targetWidth, int targetHeight) {
  if (sourceWidth == 0u || sourceHeight == 0u || targetWidth <= 0 || targetHeight <= 0) {
    return {0, 0, sourceWidth, sourceHeight};
  }

  const double sourceAspect = static_cast<double>(sourceWidth) / static_cast<double>(sourceHeight);
  const double targetAspect = static_cast<double>(targetWidth) / static_cast<double>(targetHeight);

  if (sourceAspect > targetAspect) {
    const uint32_t cropWidth = std::max<uint32_t>(1u, static_cast<uint32_t>(std::round(sourceHeight * targetAspect)));
    return {(sourceWidth - std::min(sourceWidth, cropWidth)) / 2u, 0, std::min(sourceWidth, cropWidth), sourceHeight};
  }

  const uint32_t cropHeight = std::max<uint32_t>(1u, static_cast<uint32_t>(std::round(sourceWidth / targetAspect)));
  return {0, (sourceHeight - std::min(sourceHeight, cropHeight)) / 2u, sourceWidth, std::min(sourceHeight, cropHeight)};
}

void drawCamera(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const Rect &rect, const VideoFrame *cameraFrame) {
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  if (cameraFrame == nullptr || cameraFrame->rgba.empty() || cameraFrame->width == 0 || cameraFrame->height == 0) {
    fillRect(frame, width, height, rect, 255, 255, 255, 46);
    const Rect head{rect.x + rect.width / 3, rect.y + rect.height / 5, rect.width / 3, rect.width / 3};
    fillRect(frame, width, height, head, 255, 255, 255, 80);
    return;
  }

  const int minX = std::max(0, rect.x);
  const int minY = std::max(0, rect.y);
  const int maxX = std::min(static_cast<int>(width), rect.x + rect.width);
  const int maxY = std::min(static_cast<int>(height), rect.y + rect.height);
  const SourceRect source = coverSourceRect(cameraFrame->width, cameraFrame->height, rect.width, rect.height);
  for (int y = minY; y < maxY; ++y) {
    const uint32_t sy = std::min(
        cameraFrame->height - 1u,
        source.y + static_cast<uint32_t>((static_cast<uint64_t>(y - rect.y) * source.height) / static_cast<uint32_t>(rect.height)));
    for (int x = minX; x < maxX; ++x) {
      const uint32_t sx = std::min(
          cameraFrame->width - 1u,
          source.x + static_cast<uint32_t>((static_cast<uint64_t>(x - rect.x) * source.width) / static_cast<uint32_t>(rect.width)));
      const size_t srcOffset = (static_cast<size_t>(sy) * cameraFrame->width + sx) * 4u;
      blendPixel(frame, width, height, x, y,
                 cameraFrame->rgba[srcOffset + 0],
                 cameraFrame->rgba[srcOffset + 1],
                 cameraFrame->rgba[srcOffset + 2],
                 cameraFrame->rgba[srcOffset + 3]);
    }
  }
}

void drawMediaLayer(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const MediaLayerState &mediaLayer) {
  if (!mediaLayer.enabled) {
    return;
  }
  Rect rect;
  if (mediaLayer.mode == "fullscreen") {
    rect = {static_cast<int>(width * 0.06), static_cast<int>(height * 0.08), static_cast<int>(width * 0.88), static_cast<int>(height * 0.72)};
  } else {
    rect = {
      static_cast<int>(width * clamp01(mediaLayer.x)),
      static_cast<int>(height * clamp01(mediaLayer.y)),
      static_cast<int>(width * std::clamp(mediaLayer.width, 0.05, 1.0)),
      static_cast<int>(height * std::clamp(mediaLayer.height, 0.05, 1.0)),
    };
  }
  fillRect(frame, width, height, rect, 14, 116, 144, 210);
  fillRect(frame, width, height, {rect.x + 8, rect.y + 8, std::max(0, rect.width - 16), 3}, 255, 255, 255, 190);
}

void drawGraphicsFrame(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const VideoFrame *graphicsFrame) {
  if (graphicsFrame == nullptr || graphicsFrame->rgba.empty() || graphicsFrame->width == 0u || graphicsFrame->height == 0u) {
    return;
  }

  const Rect rect{0, 0, static_cast<int>(width), static_cast<int>(height)};
  const SourceRect source = coverSourceRect(graphicsFrame->width, graphicsFrame->height, rect.width, rect.height);
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t sy = std::min(
        graphicsFrame->height - 1u,
        source.y + static_cast<uint32_t>((static_cast<uint64_t>(y) * source.height) / height));
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t sx = std::min(
          graphicsFrame->width - 1u,
          source.x + static_cast<uint32_t>((static_cast<uint64_t>(x) * source.width) / width));
      const size_t srcOffset = (static_cast<size_t>(sy) * graphicsFrame->width + sx) * 4u;
      blendPixel(frame, width, height, static_cast<int>(x), static_cast<int>(y),
                 graphicsFrame->rgba[srcOffset + 0],
                 graphicsFrame->rgba[srcOffset + 1],
                 graphicsFrame->rgba[srcOffset + 2],
                 graphicsFrame->rgba[srcOffset + 3]);
    }
  }
}

void drawGraphics(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const GraphicsState &graphics) {
  if (!graphics.enabled) {
    return;
  }
  const Rect lowerThird{static_cast<int>(width * 0.08), static_cast<int>(height * 0.76), static_cast<int>(width * 0.48), static_cast<int>(height * 0.10)};
  fillRect(frame, width, height, lowerThird, 255, 255, 255, 225);
  fillRect(frame, width, height, {lowerThird.x, lowerThird.y, lowerThird.width, 5}, 255, 132, 28, 255);
}

void drawCornerbug(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const CornerbugState &cornerbug) {
  if (!cornerbug.enabled) {
    return;
  }
  const int size = static_cast<int>(std::min(width, height) * std::clamp(cornerbug.size, 0.04, 0.35));
  const Rect rect{
    static_cast<int>(width * clamp01(cornerbug.x)),
    static_cast<int>(height * clamp01(cornerbug.y)),
    size,
    size,
  };
  fillRect(frame, width, height, rect, 255, 132, 28, 240);
  fillRect(frame, width, height, {rect.x + size / 5, rect.y + size / 5, size * 3 / 5, size * 3 / 5}, 255, 255, 255, 160);
}

}  // namespace

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  CompositorSnapshot snapshot;
  snapshot.keyerEnabled = state.keyerEnabled;
  snapshot.backgroundMode = state.backgroundMode;
  snapshot.speakerLayout = state.speakerLayout;
  snapshot.cornerbug = state.cornerbug;
  snapshot.mediaLayer = state.mediaLayer;
  snapshot.graphics = state.graphics;
  return snapshot;
}

void renderProgramFrame(const Options &options,
                        const CompositorSnapshot &snapshot,
                        const VideoFrame *cameraFrame,
                        const VideoFrame *graphicsFrame,
                        uint64_t frameIndex,
                        std::vector<uint8_t> &output) {
  fillBackground(output, options.width, options.height, snapshot.backgroundMode, frameIndex);
  drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
  drawGraphicsFrame(output, options.width, options.height, graphicsFrame);
  drawCamera(output, options.width, options.height, cameraRect(options.width, options.height, snapshot.speakerLayout), cameraFrame);
  drawGraphics(output, options.width, options.height, snapshot.graphics);
  drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
}

}  // namespace broadify::meeting
