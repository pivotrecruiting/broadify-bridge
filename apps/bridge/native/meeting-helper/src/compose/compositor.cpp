#include "compose/compositor.h"
#include "util/json_utils.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cmath>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#endif

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

struct RgbaImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> rgba;
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

std::vector<uint8_t> decodeBase64(const std::string &value) {
  std::vector<int> table(256, -1);
  for (int i = 0; i < 26; ++i) {
    table[static_cast<size_t>('A' + i)] = i;
    table[static_cast<size_t>('a' + i)] = i + 26;
  }
  for (int i = 0; i < 10; ++i) {
    table[static_cast<size_t>('0' + i)] = i + 52;
  }
  table[static_cast<size_t>('+')] = 62;
  table[static_cast<size_t>('/')] = 63;

  std::vector<uint8_t> decoded;
  int accumulator = 0;
  int bits = -8;
  for (unsigned char ch : value) {
    if (ch == '=') {
      break;
    }
    if (std::isspace(ch)) {
      continue;
    }
    const int part = table[ch];
    if (part < 0) {
      return {};
    }
    accumulator = (accumulator << 6) + part;
    bits += 6;
    if (bits >= 0) {
      decoded.push_back(static_cast<uint8_t>((accumulator >> bits) & 0xff));
      bits -= 8;
    }
  }
  return decoded;
}

std::vector<uint8_t> decodeDataUrlBytes(const std::string &dataUrl) {
  const size_t comma = dataUrl.find(',');
  if (comma == std::string::npos) {
    return {};
  }
  const std::string metadata = dataUrl.substr(0, comma);
  if (metadata.find(";base64") == std::string::npos) {
    return {};
  }
  return decodeBase64(dataUrl.substr(comma + 1));
}

#if defined(__APPLE__)
std::shared_ptr<const RgbaImage> decodeImageBytes(const std::vector<uint8_t> &bytes) {
  if (bytes.empty()) {
    return nullptr;
  }

  CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes.data(), static_cast<CFIndex>(bytes.size()));
  if (!data) {
    return nullptr;
  }

  CGImageSourceRef source = CGImageSourceCreateWithData(data, nullptr);
  CFRelease(data);
  if (!source) {
    return nullptr;
  }

  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
  CFRelease(source);
  if (!image) {
    return nullptr;
  }

  const size_t width = CGImageGetWidth(image);
  const size_t height = CGImageGetHeight(image);
  if (width == 0 || height == 0 || width > 4096 || height > 4096) {
    CGImageRelease(image);
    return nullptr;
  }

  auto decoded = std::make_shared<RgbaImage>();
  decoded->width = static_cast<uint32_t>(width);
  decoded->height = static_cast<uint32_t>(height);
  decoded->rgba.assign(width * height * 4u, 0);

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(decoded->rgba.data(),
                                               width,
                                               height,
                                               8,
                                               width * 4u,
                                               colorSpace,
                                               kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (!context) {
    CGImageRelease(image);
    return nullptr;
  }

  CGContextClearRect(context, CGRectMake(0, 0, static_cast<CGFloat>(width), static_cast<CGFloat>(height)));
  CGContextDrawImage(context, CGRectMake(0, 0, static_cast<CGFloat>(width), static_cast<CGFloat>(height)), image);
  CGContextRelease(context);
  CGImageRelease(image);
  return decoded;
}
#else
std::shared_ptr<const RgbaImage> decodeImageBytes(const std::vector<uint8_t> &) {
  return nullptr;
}
#endif

std::shared_ptr<const RgbaImage> getCornerbugImage(const CornerbugState &cornerbug) {
  const std::string dataUrl = extractStringField(cornerbug.rawJson, "image_data_url");
  if (dataUrl.empty()) {
    return nullptr;
  }

  static std::mutex cacheMutex;
  static std::string cachedDataUrl;
  static std::shared_ptr<const RgbaImage> cachedImage;

  std::lock_guard<std::mutex> lock(cacheMutex);
  if (dataUrl == cachedDataUrl) {
    return cachedImage;
  }

  cachedDataUrl = dataUrl;
  cachedImage = decodeImageBytes(decodeDataUrlBytes(dataUrl));
  return cachedImage;
}

std::shared_ptr<const RgbaImage> getMediaLayerImage(const MediaLayerState &mediaLayer) {
  if (mediaLayer.renderedPagePath.empty() || mediaLayer.renderStatus != "ready") {
    return nullptr;
  }

  static std::mutex cacheMutex;
  static std::string cachedPath;
  static std::shared_ptr<const RgbaImage> cachedImage;

  std::lock_guard<std::mutex> lock(cacheMutex);
  if (mediaLayer.renderedPagePath == cachedPath) {
    return cachedImage;
  }

  std::ifstream file(mediaLayer.renderedPagePath, std::ios::binary);
  if (!file) {
    cachedPath = mediaLayer.renderedPagePath;
    cachedImage = nullptr;
    return nullptr;
  }
  std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(file)),
      std::istreambuf_iterator<char>());
  cachedPath = mediaLayer.renderedPagePath;
  cachedImage = decodeImageBytes(bytes);
  return cachedImage;
}

void drawImageFit(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const Rect &target, const RgbaImage &image) {
  if (target.width <= 0 || target.height <= 0 || image.width == 0 || image.height == 0 || image.rgba.empty()) {
    return;
  }

  const double scale = std::min(
      static_cast<double>(target.width) / static_cast<double>(image.width),
      static_cast<double>(target.height) / static_cast<double>(image.height));
  const int drawWidth = std::max(1, static_cast<int>(std::round(image.width * scale)));
  const int drawHeight = std::max(1, static_cast<int>(std::round(image.height * scale)));
  const int drawX = target.x + (target.width - drawWidth) / 2;
  const int drawY = target.y + (target.height - drawHeight) / 2;

  for (int y = 0; y < drawHeight; ++y) {
    const double sourceY = ((static_cast<double>(y) + 0.5) * image.height / drawHeight) - 0.5;
    const uint32_t y0 = static_cast<uint32_t>(std::clamp(static_cast<int>(std::floor(sourceY)), 0, static_cast<int>(image.height) - 1));
    const uint32_t y1 = std::min(y0 + 1u, image.height - 1u);
    const double yWeight = std::clamp(sourceY - std::floor(sourceY), 0.0, 1.0);
    for (int x = 0; x < drawWidth; ++x) {
      const double sourceX = ((static_cast<double>(x) + 0.5) * image.width / drawWidth) - 0.5;
      const uint32_t x0 = static_cast<uint32_t>(std::clamp(static_cast<int>(std::floor(sourceX)), 0, static_cast<int>(image.width) - 1));
      const uint32_t x1 = std::min(x0 + 1u, image.width - 1u);
      const double xWeight = std::clamp(sourceX - std::floor(sourceX), 0.0, 1.0);
      const size_t topLeftOffset = (static_cast<size_t>(y0) * image.width + x0) * 4u;
      const size_t topRightOffset = (static_cast<size_t>(y0) * image.width + x1) * 4u;
      const size_t bottomLeftOffset = (static_cast<size_t>(y1) * image.width + x0) * 4u;
      const size_t bottomRightOffset = (static_cast<size_t>(y1) * image.width + x1) * 4u;
      const auto sample = [&](size_t channel) {
        const double top = image.rgba[topLeftOffset + channel] * (1.0 - xWeight) + image.rgba[topRightOffset + channel] * xWeight;
        const double bottom = image.rgba[bottomLeftOffset + channel] * (1.0 - xWeight) + image.rgba[bottomRightOffset + channel] * xWeight;
        return clampByte(static_cast<int>(std::round(top * (1.0 - yWeight) + bottom * yWeight)));
      };
      const uint8_t alpha = sample(3u);
      if (alpha == 0u) {
        continue;
      }
      uint8_t r = sample(0u);
      uint8_t g = sample(1u);
      uint8_t b = sample(2u);
      if (alpha > 0u && alpha < 255u) {
        r = clampByte((static_cast<int>(r) * 255) / alpha);
        g = clampByte((static_cast<int>(g) * 255) / alpha);
        b = clampByte((static_cast<int>(b) * 255) / alpha);
      }
      blendPixel(frame, width, height, drawX + x, drawY + y, r, g, b, alpha);
    }
  }
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

void fillRotatedRect(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const Rect &rect, double rotationDeg, uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) {
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  if (std::abs(rotationDeg) < 0.001) {
    fillRect(frame, width, height, rect, r, g, b, a);
    return;
  }

  constexpr double kPi = 3.14159265358979323846;
  const double radians = rotationDeg * kPi / 180.0;
  const double cosTheta = std::cos(radians);
  const double sinTheta = std::sin(radians);
  const double centerX = rect.x + rect.width / 2.0;
  const double centerY = rect.y + rect.height / 2.0;
  const double halfWidth = rect.width / 2.0;
  const double halfHeight = rect.height / 2.0;
  const double extentX = std::abs(halfWidth * cosTheta) + std::abs(halfHeight * sinTheta);
  const double extentY = std::abs(halfWidth * sinTheta) + std::abs(halfHeight * cosTheta);
  const int minX = std::max(0, static_cast<int>(std::floor(centerX - extentX)));
  const int minY = std::max(0, static_cast<int>(std::floor(centerY - extentY)));
  const int maxX = std::min(static_cast<int>(width), static_cast<int>(std::ceil(centerX + extentX)));
  const int maxY = std::min(static_cast<int>(height), static_cast<int>(std::ceil(centerY + extentY)));

  for (int y = minY; y < maxY; ++y) {
    for (int x = minX; x < maxX; ++x) {
      const double dx = (x + 0.5) - centerX;
      const double dy = (y + 0.5) - centerY;
      const double localX = dx * cosTheta + dy * sinTheta;
      const double localY = -dx * sinTheta + dy * cosTheta;
      if (std::abs(localX) <= halfWidth && std::abs(localY) <= halfHeight) {
        blendPixel(frame, width, height, x, y, r, g, b, a);
      }
    }
  }
}

void drawGlassRect(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const Rect &rect, double rotationDeg = 0.0) {
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  fillRotatedRect(frame, width, height, {rect.x + 8, rect.y + 10, rect.width, rect.height}, rotationDeg, 0, 0, 0, 46);
  fillRotatedRect(frame, width, height, rect, rotationDeg, 255, 255, 255, 36);
  fillRotatedRect(frame, width, height, {rect.x + 1, rect.y + 1, std::max(0, rect.width - 2), 2}, rotationDeg, 255, 255, 255, 92);
  fillRotatedRect(frame, width, height, {rect.x + 1, rect.y + 1, 2, std::max(0, rect.height - 2)}, rotationDeg, 255, 255, 255, 54);
  fillRotatedRect(frame, width, height, {rect.x + rect.width - 3, rect.y + 1, 2, std::max(0, rect.height - 2)}, rotationDeg, 255, 255, 255, 24);
  fillRotatedRect(frame, width, height, {rect.x + 1, rect.y + rect.height - 3, std::max(0, rect.width - 2), 2}, rotationDeg, 255, 255, 255, 24);
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
  const int frameWidth = static_cast<int>(width);
  const int frameHeight = static_cast<int>(height);
  const int marginX = 0;
  const int marginBottom = 0;
  const double speakerAspect = 16.0 / 9.0;
  int rectHeight = static_cast<int>(height * 0.50 * scale);
  int rectWidth = static_cast<int>(std::round(rectHeight * speakerAspect));
  const int maxRectWidth = std::max(1, frameWidth - marginX * 2);
  const int maxRectHeight = std::max(1, frameHeight - marginBottom);
  if (rectWidth > maxRectWidth) {
    rectWidth = maxRectWidth;
    rectHeight = static_cast<int>(std::round(rectWidth / speakerAspect));
  }
  if (rectHeight > maxRectHeight) {
    rectHeight = maxRectHeight;
    rectWidth = static_cast<int>(std::round(rectHeight * speakerAspect));
  }
  const int edgeCrop = static_cast<int>(std::round(rectWidth * 0.28));
  int x = frameWidth - rectWidth - marginX + edgeCrop;
  if (speakerLayout.layout == "left") {
    x = marginX - edgeCrop;
  } else if (speakerLayout.layout == "center") {
    x = (frameWidth - rectWidth) / 2;
  }
  x = std::clamp(x, -edgeCrop, std::max(0, frameWidth - rectWidth) + edgeCrop);
  const int y = std::clamp(frameHeight - rectHeight - marginBottom, 0, std::max(0, frameHeight - rectHeight));
  return {x, y, rectWidth, rectHeight};
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

void drawCamera(std::vector<uint8_t> &frame,
                uint32_t width,
                uint32_t height,
                const Rect &rect,
                const VideoFrame *cameraFrame,
                bool mirror) {
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  if (cameraFrame == nullptr || cameraFrame->rgba.empty() || cameraFrame->width == 0 || cameraFrame->height == 0) {
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
      const uint32_t sampledX = std::min(
          cameraFrame->width - 1u,
          source.x + static_cast<uint32_t>((static_cast<uint64_t>(x - rect.x) * source.width) / static_cast<uint32_t>(rect.width)));
      const uint32_t sx = mirror
          ? source.x + source.width - 1u - (sampledX - source.x)
          : sampledX;
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
    rect = {0, 0, static_cast<int>(width), static_cast<int>(height)};
  } else {
    rect = {
      static_cast<int>(width * clamp01(mediaLayer.x)),
      static_cast<int>(height * clamp01(mediaLayer.y)),
      static_cast<int>(width * std::clamp(mediaLayer.width, 0.05, 1.0)),
      static_cast<int>(height * std::clamp(mediaLayer.height, 0.05, 1.0)),
    };
  }
  const auto image = getMediaLayerImage(mediaLayer);
  if (image != nullptr) {
    fillRotatedRect(frame, width, height, {rect.x + 8, rect.y + 10, rect.width, rect.height}, mediaLayer.rotation, 0, 0, 0, 46);
    drawImageFit(frame, width, height, rect, *image);
    return;
  }

  drawGlassRect(frame, width, height, rect, mediaLayer.rotation);
  fillRotatedRect(frame, width, height, {rect.x + 12, rect.y + 12, std::max(0, rect.width - 24), 4}, mediaLayer.rotation, 255, 255, 255, 108);
  fillRotatedRect(frame, width, height, {rect.x + 12, rect.y + rect.height - 18, std::max(0, (rect.width - 24) * 2 / 3), 6}, mediaLayer.rotation, 255, 255, 255, 78);
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
    static_cast<int>(width * clamp01(cornerbug.x)) - size / 2,
    static_cast<int>(height * clamp01(cornerbug.y)) - size / 2,
    size,
    size,
  };
  if (const std::shared_ptr<const RgbaImage> image = getCornerbugImage(cornerbug)) {
    drawImageFit(frame, width, height, rect, *image);
    return;
  }
  drawGlassRect(frame, width, height, rect);
  fillRect(frame, width, height, {rect.x + size / 5, rect.y + size / 5, size * 3 / 5, size * 3 / 5}, 255, 255, 255, 72);
  fillRect(frame, width, height, {rect.x + size / 3, rect.y + size / 3, size / 3, size / 3}, 255, 255, 255, 52);
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
  snapshot.cameraRender = state.cameraRender;
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
  if (snapshot.cameraRender.enabled) {
    drawCamera(
        output,
        options.width,
        options.height,
        cameraRect(options.width, options.height, snapshot.speakerLayout),
        cameraFrame,
        snapshot.cameraRender.mirror);
  }
  drawGraphics(output, options.width, options.height, snapshot.graphics);
  drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
}

}  // namespace broadify::meeting
