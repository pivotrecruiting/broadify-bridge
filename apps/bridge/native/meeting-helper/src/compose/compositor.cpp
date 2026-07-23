#include "compose/compositor.h"
#include "compose/metal_compositor.h"
#if defined(_WIN32)
#include "compose/d3d11_compositor.h"
#endif
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

// Cached loader for the uploaded company background image (single slot, same
// pattern as the media layer image cache). Empty path clears the layer.
std::shared_ptr<const RgbaImage> getBackgroundImage(const std::string &path) {
  if (path.empty()) {
    return nullptr;
  }

  static std::mutex cacheMutex;
  static std::string cachedPath;
  static std::shared_ptr<const RgbaImage> cachedImage;

  std::lock_guard<std::mutex> lock(cacheMutex);
  if (path == cachedPath) {
    return cachedImage;
  }

  std::ifstream file(path, std::ios::binary);
  cachedPath = path;
  if (!file) {
    cachedImage = nullptr;
    return nullptr;
  }
  const std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(file)),
      std::istreambuf_iterator<char>());
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
  int rectHeight = static_cast<int>(height * 0.82 * scale);
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
  // Keep the keyed speaker fully in frame: only a small nudge toward the edge
  // instead of pushing ~28% of the person off-screen.
  const int edgeCrop = static_cast<int>(std::round(rectWidth * 0.05));
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
                const AlphaMask *cameraMask,
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
      uint8_t alpha = cameraFrame->rgba[srcOffset + 3];
      if (cameraMask != nullptr && !cameraMask->alpha.empty() &&
          cameraMask->width > 0u && cameraMask->height > 0u) {
        const double maskX = cameraFrame->width > 1u
            ? static_cast<double>(sx) * static_cast<double>(cameraMask->width - 1u) /
                  static_cast<double>(cameraFrame->width - 1u)
            : 0.0;
        const double maskY = cameraFrame->height > 1u
            ? static_cast<double>(sy) * static_cast<double>(cameraMask->height - 1u) /
                  static_cast<double>(cameraFrame->height - 1u)
            : 0.0;
        const uint32_t mx0 = static_cast<uint32_t>(std::floor(maskX));
        const uint32_t my0 = static_cast<uint32_t>(std::floor(maskY));
        const uint32_t mx1 = std::min(mx0 + 1u, cameraMask->width - 1u);
        const uint32_t my1 = std::min(my0 + 1u, cameraMask->height - 1u);
        const double wx = maskX - static_cast<double>(mx0);
        const double wy = maskY - static_cast<double>(my0);
        const double top = cameraMask->alpha[static_cast<size_t>(my0) * cameraMask->width + mx0] * (1.0 - wx) +
            cameraMask->alpha[static_cast<size_t>(my0) * cameraMask->width + mx1] * wx;
        const double bottom = cameraMask->alpha[static_cast<size_t>(my1) * cameraMask->width + mx0] * (1.0 - wx) +
            cameraMask->alpha[static_cast<size_t>(my1) * cameraMask->width + mx1] * wx;
        alpha = clampByte(static_cast<int>(std::round(top * (1.0 - wy) + bottom * wy)));
      }
      blendPixel(frame, width, height, x, y,
                 cameraFrame->rgba[srcOffset + 0],
                 cameraFrame->rgba[srcOffset + 1],
                 cameraFrame->rgba[srcOffset + 2],
                 alpha);
    }
  }
}


void sampleImageBilinear(const RgbaImage &image, double sourceX, double sourceY, uint8_t sample[4]) {
  const uint32_t x0 = static_cast<uint32_t>(std::clamp(static_cast<int>(std::floor(sourceX)), 0, static_cast<int>(image.width) - 1));
  const uint32_t x1 = std::min(x0 + 1u, image.width - 1u);
  const double xWeight = std::clamp(sourceX - std::floor(sourceX), 0.0, 1.0);
  const uint32_t y0 = static_cast<uint32_t>(std::clamp(static_cast<int>(std::floor(sourceY)), 0, static_cast<int>(image.height) - 1));
  const uint32_t y1 = std::min(y0 + 1u, image.height - 1u);
  const double yWeight = std::clamp(sourceY - std::floor(sourceY), 0.0, 1.0);
  const size_t topLeftOffset = (static_cast<size_t>(y0) * image.width + x0) * 4u;
  const size_t topRightOffset = (static_cast<size_t>(y0) * image.width + x1) * 4u;
  const size_t bottomLeftOffset = (static_cast<size_t>(y1) * image.width + x0) * 4u;
  const size_t bottomRightOffset = (static_cast<size_t>(y1) * image.width + x1) * 4u;
  for (size_t channel = 0; channel < 4u; ++channel) {
    const double top = image.rgba[topLeftOffset + channel] * (1.0 - xWeight) + image.rgba[topRightOffset + channel] * xWeight;
    const double bottom = image.rgba[bottomLeftOffset + channel] * (1.0 - xWeight) + image.rgba[bottomRightOffset + channel] * xWeight;
    sample[channel] = clampByte(static_cast<int>(std::round(top * (1.0 - yWeight) + bottom * yWeight)));
  }
}

// Samples one fitted-image pixel (bilinear, un-premultiplied) and blends it.
void blendSampledImagePixel(std::vector<uint8_t> &frame,
                            uint32_t width,
                            uint32_t height,
                            const RgbaImage &image,
                            double sourceX,
                            double sourceY,
                            int x,
                            int y) {
  uint8_t sample[4];
  sampleImageBilinear(image, sourceX, sourceY, sample);
  const uint8_t alpha = sample[3];
  if (alpha == 0u) {
    return;
  }
  uint8_t r = sample[0];
  uint8_t g = sample[1];
  uint8_t b = sample[2];
  if (alpha < 255u) {
    r = clampByte((static_cast<int>(r) * 255) / alpha);
    g = clampByte((static_cast<int>(g) * 255) / alpha);
    b = clampByte((static_cast<int>(b) * 255) / alpha);
  }
  blendPixel(frame, width, height, x, y, r, g, b, alpha);
}

// Perspective depth for X/Y-rotated media panels, relative to the panel size.
// Mirrors the CSS `perspective()` look in the builder preview: large enough
// to avoid extreme distortion, small enough that a turned panel visibly
// "stands in the room" (news-studio style).
constexpr double kMediaPerspectiveFactor = 3.0;

// Draws the image fitted into the target rect and rotated around the rect
// center on all three axes, matching the builder preview's CSS
// `rotateX(a) rotateY(b) rotateZ(c)` order. Pure Z rotation stays planar and
// is drawn through an inverse affine map; X/Y rotation leaves the image
// plane and is projected with a CSS-like perspective, inverted per pixel via
// the homography of the projected quad.
void drawImageFitRotated(std::vector<uint8_t> &frame,
                         uint32_t width,
                         uint32_t height,
                         const Rect &target,
                         const RgbaImage &image,
                         double rotationXDeg,
                         double rotationYDeg,
                         double rotationZDeg) {
  if (std::abs(rotationXDeg) < 0.001 && std::abs(rotationYDeg) < 0.001 && std::abs(rotationZDeg) < 0.001) {
    drawImageFit(frame, width, height, target, image);
    return;
  }
  if (target.width <= 0 || target.height <= 0 || image.width == 0 || image.height == 0 || image.rgba.empty()) {
    return;
  }

  const double scale = std::min(
      static_cast<double>(target.width) / static_cast<double>(image.width),
      static_cast<double>(target.height) / static_cast<double>(image.height));
  const double drawWidth = std::max(1.0, image.width * scale);
  const double drawHeight = std::max(1.0, image.height * scale);
  const double halfWidth = drawWidth / 2.0;
  const double halfHeight = drawHeight / 2.0;
  const double centerX = target.x + target.width / 2.0;
  const double centerY = target.y + target.height / 2.0;

  constexpr double kPi = 3.14159265358979323846;
  const double angleX = rotationXDeg * kPi / 180.0;
  const double angleY = rotationYDeg * kPi / 180.0;
  const double angleZ = rotationZDeg * kPi / 180.0;
  const double ca = std::cos(angleX);
  const double sa = std::sin(angleX);
  const double cb = std::cos(angleY);
  const double sb = std::sin(angleY);
  const double cc = std::cos(angleZ);
  const double sc = std::sin(angleZ);

  const bool hasDepthRotation = std::abs(rotationXDeg) >= 0.001 || std::abs(rotationYDeg) >= 0.001;
  if (hasDepthRotation) {
    // Full rotation matrix M = Rx*Ry*Rz applied to the panel plane (z = 0),
    // then perspective projection: p' = p * d / (d - z).
    const double m00 = cb * cc;
    const double m01 = -cb * sc;
    const double m10 = ca * sc + sa * sb * cc;
    const double m11 = ca * cc - sa * sb * sc;
    const double m20 = sa * sc - ca * sb * cc;
    const double m21 = sa * cc + ca * sb * sc;
    const double depth = kMediaPerspectiveFactor * std::max(drawWidth, drawHeight);

    // Projected quad corners for (u,v) = (0,0), (1,0), (1,1), (0,1).
    const double localXs[4] = {-halfWidth, halfWidth, halfWidth, -halfWidth};
    const double localYs[4] = {-halfHeight, -halfHeight, halfHeight, halfHeight};
    double quadX[4];
    double quadY[4];
    for (int corner = 0; corner < 4; ++corner) {
      const double rotatedX = m00 * localXs[corner] + m01 * localYs[corner];
      const double rotatedY = m10 * localXs[corner] + m11 * localYs[corner];
      const double rotatedZ = m20 * localXs[corner] + m21 * localYs[corner];
      const double denominator = depth - rotatedZ;
      if (denominator <= 1.0) {
        // Corner behind the camera (only possible for extreme angles): give
        // up on perspective and let the affine path below handle it.
        break;
      }
      const double projectionScale = depth / denominator;
      quadX[corner] = centerX + rotatedX * projectionScale;
      quadY[corner] = centerY + rotatedY * projectionScale;
      if (corner == 3) {
        // Homography H mapping (u,v) in [0,1]^2 onto the projected quad.
        const double dx1 = quadX[1] - quadX[2];
        const double dx2 = quadX[3] - quadX[2];
        const double dx3 = quadX[0] - quadX[1] + quadX[2] - quadX[3];
        const double dy1 = quadY[1] - quadY[2];
        const double dy2 = quadY[3] - quadY[2];
        const double dy3 = quadY[0] - quadY[1] + quadY[2] - quadY[3];
        const double denominatorH = dx1 * dy2 - dx2 * dy1;
        if (std::abs(denominatorH) < 1e-9) {
          break;
        }
        const double g = (dx3 * dy2 - dx2 * dy3) / denominatorH;
        const double h = (dx1 * dy3 - dx3 * dy1) / denominatorH;
        const double a = quadX[1] - quadX[0] + g * quadX[1];
        const double b = quadX[3] - quadX[0] + h * quadX[3];
        const double c = quadX[0];
        const double d = quadY[1] - quadY[0] + g * quadY[1];
        const double e = quadY[3] - quadY[0] + h * quadY[3];
        const double f = quadY[0];

        // Inverse of H = [[a,b,c],[d,e,f],[g,h,1]] via adjugate.
        const double inv00 = e - f * h;
        const double inv01 = c * h - b;
        const double inv02 = b * f - c * e;
        const double inv10 = f * g - d;
        const double inv11 = a - c * g;
        const double inv12 = c * d - a * f;
        const double inv20 = d * h - e * g;
        const double inv21 = b * g - a * h;
        const double inv22 = a * e - b * d;

        const int minX = std::max(0, static_cast<int>(std::floor(std::min({quadX[0], quadX[1], quadX[2], quadX[3]}))));
        const int maxX = std::min(static_cast<int>(width), static_cast<int>(std::ceil(std::max({quadX[0], quadX[1], quadX[2], quadX[3]}))));
        const int minY = std::max(0, static_cast<int>(std::floor(std::min({quadY[0], quadY[1], quadY[2], quadY[3]}))));
        const int maxY = std::min(static_cast<int>(height), static_cast<int>(std::ceil(std::max({quadY[0], quadY[1], quadY[2], quadY[3]}))));

        for (int y = minY; y < maxY; ++y) {
          for (int x = minX; x < maxX; ++x) {
            const double px = x + 0.5;
            const double py = y + 0.5;
            const double w = inv20 * px + inv21 * py + inv22;
            if (std::abs(w) < 1e-9) {
              continue;
            }
            const double u = (inv00 * px + inv01 * py + inv02) / w;
            const double v = (inv10 * px + inv11 * py + inv12) / w;
            if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
              continue;
            }
            const double sourceX = u * image.width - 0.5;
            const double sourceY = v * image.height - 0.5;
            blendSampledImagePixel(frame, width, height, image, sourceX, sourceY, x, y);
          }
        }
        return;
      }
    }
  }

  const double a00 = cb * cc;
  const double a01 = -cb * sc;
  const double a10 = ca * sc + sa * sb * cc;
  const double a11 = ca * cc - sa * sb * sc;
  const double det = a00 * a11 - a01 * a10;
  if (std::abs(det) < 1e-6) {
    // Edge-on (e.g. 90° X/Y rotation): the plane projects to a line.
    return;
  }
  const double inv00 = a11 / det;
  const double inv01 = -a01 / det;
  const double inv10 = -a10 / det;
  const double inv11 = a00 / det;

  const double extentX = std::abs(a00 * halfWidth) + std::abs(a01 * halfHeight);
  const double extentY = std::abs(a10 * halfWidth) + std::abs(a11 * halfHeight);
  const int minX = std::max(0, static_cast<int>(std::floor(centerX - extentX)));
  const int minY = std::max(0, static_cast<int>(std::floor(centerY - extentY)));
  const int maxX = std::min(static_cast<int>(width), static_cast<int>(std::ceil(centerX + extentX)));
  const int maxY = std::min(static_cast<int>(height), static_cast<int>(std::ceil(centerY + extentY)));

  for (int y = minY; y < maxY; ++y) {
    for (int x = minX; x < maxX; ++x) {
      const double dx = (x + 0.5) - centerX;
      const double dy = (y + 0.5) - centerY;
      const double localX = inv00 * dx + inv01 * dy;
      const double localY = inv10 * dx + inv11 * dy;
      if (std::abs(localX) > halfWidth || std::abs(localY) > halfHeight) {
        continue;
      }
      const double sourceX = ((localX + halfWidth) / drawWidth) * image.width - 0.5;
      const double sourceY = ((localY + halfHeight) / drawHeight) * image.height - 0.5;
      blendSampledImagePixel(frame, width, height, image, sourceX, sourceY, x, y);
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
    // No full-panel backdrop behind the content. The drop shadow was drawn at
    // the whole 16:9 media rect, so for a portrait document it overhung the
    // page on both sides and read as a translucent panel. Draw only the fitted
    // content itself, tilted in perspective when a rotation is set (News style).
    drawImageFitRotated(frame, width, height, rect, *image,
                        mediaLayer.rotationX, mediaLayer.rotationY,
                        mediaLayer.rotation);
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

int gpuBackgroundMode(const std::string &mode) {
  if (mode == "gradient") return 1;
  if (mode == "solid_light") return 2;
  if (mode == "checkerboard") return 3;
  if (mode == "transparent") return 4;
  return 0;
}

GpuLayerMapping layerMapping(const VideoFrame *frame, const Rect &target,
                             bool mirror, bool keyed) {
  GpuLayerMapping mapping;
  if (frame == nullptr || frame->rgba.empty() || frame->width == 0u ||
      frame->height == 0u || target.width <= 0 || target.height <= 0) {
    return mapping;
  }
  const SourceRect source = coverSourceRect(frame->width, frame->height,
                                             target.width, target.height);
  mapping.present = true;
  mapping.keyed = keyed;
  mapping.mirror = mirror;
  mapping.scaleX = static_cast<float>(source.width) / static_cast<float>(target.width);
  mapping.scaleY = static_cast<float>(source.height) / static_cast<float>(target.height);
  mapping.biasX = static_cast<float>(source.x) -
      static_cast<float>(target.x) * mapping.scaleX - 0.5f;
  mapping.biasY = static_cast<float>(source.y) -
      static_cast<float>(target.y) * mapping.scaleY - 0.5f;
  mapping.mirrorConst = static_cast<float>(source.x * 2u + source.width - 1u);
  return mapping;
}

int maskAnchorBottomFrameY(const AlphaMask &mask, uint32_t frameHeight) {
  int fallbackRow = -1;
  for (int my = static_cast<int>(mask.height) - 1; my >= 0; --my) {
    const uint8_t *row =
        mask.alpha.data() + static_cast<size_t>(my) * mask.width;
    int count = 0;
    for (uint32_t mx = 0; mx < mask.width; ++mx) {
      if (row[mx] > 40u) {
        ++count;
        if (count >= 4) {
          return static_cast<int>(((my + 0.5) * frameHeight) / mask.height);
        }
      }
    }
    if (count > 0 && fallbackRow < 0) {
      fallbackRow =
          static_cast<int>(((my + 0.5) * frameHeight) / mask.height);
    }
  }
  return fallbackRow;
}

bool canUseGpuCompositor(const CompositorSnapshot &) {
  // Content is baked into the back-graphics layer before compositing (see
  // renderProgramFrame), so the GPU path handles content scenes too instead of
  // falling back to the heavy full-frame CPU compositor.
  return true;
}

GpuComposePlan buildGpuPlan(const Options &options,
                              const CompositorSnapshot &snapshot,
                              const VideoFrame *cameraFrame,
                              const AlphaMask *cameraMask,
                              const VideoFrame *backGraphicsFrame,
                              const VideoFrame *frontGraphicsFrame,
                              uint64_t frameIndex) {
  GpuComposePlan plan;
  plan.width = options.width;
  plan.height = options.height;
  plan.backgroundMode = gpuBackgroundMode(snapshot.backgroundMode);
  plan.frameIndex = frameIndex;
  plan.cameraFrame = cameraFrame;
  const Rect fullFrame{0, 0, static_cast<int>(options.width),
                       static_cast<int>(options.height)};
  // Uploaded company background image, cover-fitted below all layers. The
  // decode is cached, so the shared_ptr keeps the pixels alive for this frame.
  const std::shared_ptr<const RgbaImage> backgroundImage =
      getBackgroundImage(snapshot.backgroundImagePath);
  if (backgroundImage != nullptr && !backgroundImage->rgba.empty()) {
    plan.backgroundImage = backgroundImage->rgba.data();
    plan.backgroundImageWidth = backgroundImage->width;
    plan.backgroundImageHeight = backgroundImage->height;
    plan.backgroundImageCacheKey =
        static_cast<uint64_t>(reinterpret_cast<uintptr_t>(backgroundImage.get()));
    VideoFrame mappingFrame;
    mappingFrame.width = backgroundImage->width;
    mappingFrame.height = backgroundImage->height;
    plan.backgroundImageMapping = layerMapping(&mappingFrame, fullFrame, false, false);
  }
  const bool keyed = snapshot.keyerEnabled && cameraMask != nullptr &&
      !cameraMask->alpha.empty();
  if (snapshot.cameraRender.enabled && keyed && cameraFrame != nullptr &&
      !cameraFrame->rgba.empty()) {
    plan.cameraMask = cameraMask->alpha.data();
    plan.maskWidth = cameraMask->width;
    plan.maskHeight = cameraMask->height;
    plan.maskTimestampNs = cameraMask->timestampNs;
    const int keyedAlphaBottomY =
        maskAnchorBottomFrameY(*cameraMask, cameraFrame->height);
    if (keyedAlphaBottomY >= 0) {
      const double scale = snapshot.speakerLayout.enabled
          ? std::clamp(snapshot.speakerLayout.scale, 0.4, 1.8)
          : 1.0;
      double offsetX = 0.0;
      if (snapshot.speakerLayout.enabled) {
        const double horizontalTravel =
            static_cast<double>(plan.width) * 0.22;
        if (snapshot.speakerLayout.layout == "left") {
          offsetX -= horizontalTravel;
        } else if (snapshot.speakerLayout.layout == "right") {
          offsetX += horizontalTravel;
        }
      }
      const double sourceCenterX =
          static_cast<double>(cameraFrame->width) * 0.5;
      const double sourceCenterY =
          static_cast<double>(cameraFrame->height) * 0.5;
      const double kx =
          (static_cast<double>(plan.width) / cameraFrame->width) * scale;
      const double ky =
          (static_cast<double>(plan.height) / cameraFrame->height) * scale;
      const double targetCenterX =
          static_cast<double>(plan.width) * 0.5 + offsetX;
      const double targetBottomY = static_cast<double>(plan.height) - 0.5;
      const double targetCenterY = targetBottomY -
          ((static_cast<double>(keyedAlphaBottomY) + 0.5 - sourceCenterY) * ky);
      plan.camera.present = true;
      plan.camera.keyed = true;
      plan.camera.mirror = snapshot.cameraRender.mirror;
      plan.camera.scaleX = static_cast<float>(1.0 / kx);
      plan.camera.scaleY = static_cast<float>(1.0 / ky);
      plan.camera.biasX = static_cast<float>(
          sourceCenterX - 0.5 - targetCenterX / kx);
      plan.camera.biasY = static_cast<float>(
          sourceCenterY - 0.5 - targetCenterY / ky);
      plan.camera.mirrorConst =
          static_cast<float>(cameraFrame->width) - 1.0f;
    } else {
      plan.camera = layerMapping(cameraFrame, fullFrame,
                                 snapshot.cameraRender.mirror, false);
    }
  } else if (snapshot.cameraRender.enabled) {
    plan.camera = layerMapping(cameraFrame, fullFrame,
                               snapshot.cameraRender.mirror, false);
  }
  plan.backGraphics = backGraphicsFrame;
  plan.backMapping = layerMapping(backGraphicsFrame, fullFrame, false, false);
  plan.frontGraphics = frontGraphicsFrame;
  plan.frontMapping = layerMapping(frontGraphicsFrame, fullFrame, false, false);
  return plan;
}

void renderProgramFrameCpu(const Options &options,
                           const CompositorSnapshot &snapshot,
                           const VideoFrame *cameraFrame,
                           const AlphaMask *cameraMask,
                           const VideoFrame *backGraphicsFrame,
                           const VideoFrame *frontGraphicsFrame,
                           uint64_t frameIndex,
                           std::vector<uint8_t> &output) {
  fillBackground(output, options.width, options.height, snapshot.backgroundMode, frameIndex);
  if (const auto backgroundImage = getBackgroundImage(snapshot.backgroundImagePath)) {
    // Cover-fit the uploaded company background under all other layers.
    const SourceRect source = coverSourceRect(
        backgroundImage->width, backgroundImage->height,
        static_cast<int>(options.width), static_cast<int>(options.height));
    for (uint32_t y = 0; y < options.height; ++y) {
      const uint32_t sy = std::min(backgroundImage->height - 1u,
          source.y + static_cast<uint32_t>((static_cast<uint64_t>(y) * source.height) / options.height));
      for (uint32_t x = 0; x < options.width; ++x) {
        const uint32_t sx = std::min(backgroundImage->width - 1u,
            source.x + static_cast<uint32_t>((static_cast<uint64_t>(x) * source.width) / options.width));
        const size_t srcOffset = (static_cast<size_t>(sy) * backgroundImage->width + sx) * 4u;
        blendPixel(output, options.width, options.height, static_cast<int>(x), static_cast<int>(y),
                   backgroundImage->rgba[srcOffset + 0], backgroundImage->rgba[srcOffset + 1],
                   backgroundImage->rgba[srcOffset + 2], backgroundImage->rgba[srcOffset + 3]);
      }
    }
  }

  const bool keyedCameraFrame = snapshot.keyerEnabled &&
      cameraMask != nullptr && !cameraMask->alpha.empty();
  const bool mediaLayerIsPip =
      snapshot.mediaLayer.enabled && snapshot.mediaLayer.mode == "pip";
  const bool mediaLayerIsFullscreen =
      snapshot.mediaLayer.enabled && snapshot.mediaLayer.mode == "fullscreen";

  // Back graphics are treated as a background/backplate layer.
  // They must never cover PiP, camera/key, normal graphics or cornerbug.
  drawGraphicsFrame(output, options.width, options.height, backGraphicsFrame);

  if (keyedCameraFrame) {
    // Keyer ON with a usable mask:
    // backplate -> fullscreen background media -> PiP media -> keyed presenter.
    if (mediaLayerIsFullscreen || mediaLayerIsPip) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
    if (snapshot.cameraRender.enabled) {
      drawCamera(
          output,
          options.width,
          options.height,
          cameraRect(options.width, options.height, snapshot.speakerLayout),
          cameraFrame,
          cameraMask,
          snapshot.cameraRender.mirror);
    }
  } else {
    // Keyer OFF or keyer fallback/passthrough:
    // camera is the base layer; only PiP media draws above it.
    if (snapshot.cameraRender.enabled) {
      drawCamera(
          output,
          options.width,
          options.height,
          cameraRect(options.width, options.height, snapshot.speakerLayout),
          cameraFrame,
          cameraMask,
          snapshot.cameraRender.mirror);
    }
    if (mediaLayerIsPip) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
    // Conference: fullscreen content (e.g. a PDF) fills the frame over the
    // un-keyed camera. Meeting keeps the raw camera here (conferenceMode=false).
    if (snapshot.conferenceMode && mediaLayerIsFullscreen) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
  }

  drawGraphics(output, options.width, options.height, snapshot.graphics);
  drawGraphicsFrame(output, options.width, options.height, frontGraphicsFrame);
  drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
}

}  // namespace

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  CompositorSnapshot snapshot;
  snapshot.keyerEnabled = state.keyerEnabled;
  snapshot.conferenceMode = state.conferenceMode;
  snapshot.backgroundMode = state.backgroundMode;
  snapshot.backgroundImagePath = state.backgroundImagePath;
  snapshot.speakerLayout = state.speakerLayout;
  snapshot.cornerbug = state.cornerbug;
  snapshot.mediaLayer = state.mediaLayer;
  snapshot.graphics = state.graphics;
  snapshot.cameraRender = state.cameraRender;
  return snapshot;
}

// Draws a second live camera as a picture-in-picture inset in the bottom-right
// corner of the finished program frame. Runs on the CPU over the final RGBA
// output, so it works after either the GPU or CPU main compositing path.
void drawCameraPipInset(std::vector<uint8_t> &output, uint32_t width,
                        uint32_t height, const VideoFrame &pip) {
  if (pip.rgba.empty() || pip.width == 0u || pip.height == 0u) {
    return;
  }
  // ~28% of program width, keeping the PiP camera's aspect ratio.
  const uint32_t insetW = std::max<uint32_t>(1u, (width * 28u) / 100u);
  const uint32_t insetH = std::max<uint32_t>(
      1u, static_cast<uint32_t>((static_cast<uint64_t>(insetW) * pip.height) /
                                pip.width));
  const uint32_t margin = std::max<uint32_t>(8u, width / 80u);
  const uint32_t border = std::max<uint32_t>(2u, width / 480u);
  if (insetW + margin >= width || insetH + margin >= height) {
    return;
  }
  const uint32_t x0 = width - insetW - margin;
  const uint32_t y0 = height - insetH - margin;

  // Border frame behind the inset.
  for (uint32_t y = y0 - border; y < y0 + insetH + border; ++y) {
    for (uint32_t x = x0 - border; x < x0 + insetW + border; ++x) {
      blendPixel(output, width, height, static_cast<int>(x),
                 static_cast<int>(y), 235, 238, 242, 255);
    }
  }
  // Nearest-neighbour downscale of the PiP camera into the inset.
  for (uint32_t y = 0; y < insetH; ++y) {
    const uint32_t sy = std::min(
        pip.height - 1u,
        static_cast<uint32_t>((static_cast<uint64_t>(y) * pip.height) / insetH));
    for (uint32_t x = 0; x < insetW; ++x) {
      const uint32_t sx = std::min(
          pip.width - 1u,
          static_cast<uint32_t>((static_cast<uint64_t>(x) * pip.width) / insetW));
      const size_t s = (static_cast<size_t>(sy) * pip.width + sx) * 4u;
      blendPixel(output, width, height, static_cast<int>(x0 + x),
                 static_cast<int>(y0 + y), pip.rgba[s + 0], pip.rgba[s + 1],
                 pip.rgba[s + 2], 255);
    }
  }
}

// Conference: overlay the content (PDF/media) on the finished program frame,
// over the un-keyed camera. Runs on the CPU over the final RGBA output, after
// either GPU compositing path. The front graphics (lower thirds, overlays) are
// then re-drawn on top so they stay above the content, matching how they sit
// above the camera. No-op for meeting, where content is a backplate behind the
// keyed presenter.
void drawConferenceContentOverlay(std::vector<uint8_t> &output,
                                  const Options &options,
                                  const CompositorSnapshot &snapshot,
                                  const VideoFrame *frontGraphicsFrame) {
  if (!snapshot.conferenceMode || !snapshot.mediaLayer.enabled) {
    return;
  }
  drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
  // Front graphics (lower thirds, overlays) go back on top of the content so
  // they stay above it, the same way they sit above the camera. drawGraphicsFrame
  // is bounds-checked and a no-op when the frame is null/empty.
  if (frontGraphicsFrame != nullptr && !frontGraphicsFrame->rgba.empty()) {
    drawGraphicsFrame(output, options.width, options.height, frontGraphicsFrame);
  }
}

std::string renderProgramFrame(const Options &options,
                               const CompositorSnapshot &snapshot,
                               const VideoFrame *cameraFrame,
                               const AlphaMask *cameraMask,
                               const VideoFrame *backGraphicsFrame,
                               const VideoFrame *frontGraphicsFrame,
                               uint64_t frameIndex,
                               std::vector<uint8_t> &output) {
  // Bake the content layer into the back-graphics layer so the GPU compositor
  // can render content scenes on the GPU. Only the content's own rect plus one
  // back-buffer copy stay on the CPU; the heavy full-frame multi-layer blend
  // moves to the GPU (previously any content forced the full CPU compositor).
  const VideoFrame *effectiveBack = backGraphicsFrame;
  // Conference draws content OVER the un-keyed camera, so it is NOT baked into
  // the back layer here (that would hide it behind the opaque camera). It is
  // overlaid on the finished frame after compositing instead (see below).
  if (snapshot.mediaLayer.enabled && !snapshot.conferenceMode) {
    // Rebuild the baked layer only when its inputs change (content page,
    // transform or the back-graphics frame) instead of every frame. The stable
    // timestamp also lets the GPU skip re-uploading the unchanged texture.
    static VideoFrame cachedBack;
    static uint64_t cachedKey = 0u;
    const uint64_t backTs =
        (backGraphicsFrame != nullptr) ? backGraphicsFrame->timestampNs : 0u;
    // The uploaded company background is baked in as the base of this layer, so
    // the cache key must also track the background path — otherwise switching
    // (or clearing) the background would not rebuild the baked frame.
    const uint64_t key =
        (std::hash<std::string>{}(snapshot.mediaLayer.rawJson) * 1099511628211u +
         backTs) *
            1099511628211u +
        std::hash<std::string>{}(snapshot.backgroundImagePath);
    if (key != cachedKey || cachedBack.width != options.width ||
        cachedBack.height != options.height) {
      cachedBack.width = options.width;
      cachedBack.height = options.height;
      cachedBack.rgba.assign(
          static_cast<size_t>(options.width) * options.height * 4u, 0u);
      // Bake the uploaded company background as the opaque base FIRST, so PiP
      // content and back graphics composite over it. Baking it into this layer
      // (instead of leaving it to the separate GPU background-image pass) keeps
      // the back plate self-contained: with content enabled the GPU back layer
      // is present and full-frame, and the standalone background pass would
      // otherwise be lost, leaving the area around the content black.
      if (const auto backgroundImage =
              getBackgroundImage(snapshot.backgroundImagePath)) {
        const SourceRect source = coverSourceRect(
            backgroundImage->width, backgroundImage->height,
            static_cast<int>(options.width),
            static_cast<int>(options.height));
        for (uint32_t y = 0; y < options.height; ++y) {
          const uint32_t sy = std::min(
              backgroundImage->height - 1u,
              source.y + static_cast<uint32_t>(
                             (static_cast<uint64_t>(y) * source.height) /
                             options.height));
          for (uint32_t x = 0; x < options.width; ++x) {
            const uint32_t sx = std::min(
                backgroundImage->width - 1u,
                source.x + static_cast<uint32_t>(
                               (static_cast<uint64_t>(x) * source.width) /
                               options.width));
            const size_t srcOffset =
                (static_cast<size_t>(sy) * backgroundImage->width + sx) * 4u;
            blendPixel(cachedBack.rgba, options.width, options.height,
                       static_cast<int>(x), static_cast<int>(y),
                       backgroundImage->rgba[srcOffset + 0],
                       backgroundImage->rgba[srcOffset + 1],
                       backgroundImage->rgba[srcOffset + 2],
                       backgroundImage->rgba[srcOffset + 3]);
          }
        }
      }
      if (backGraphicsFrame != nullptr && !backGraphicsFrame->rgba.empty()) {
        drawGraphicsFrame(cachedBack.rgba, options.width, options.height,
                          backGraphicsFrame);
      }
      drawMediaLayer(cachedBack.rgba, options.width, options.height,
                     snapshot.mediaLayer);
      cachedBack.timestampNs = key;
      cachedKey = key;
    }
    effectiveBack = &cachedBack;
  }

  if (canUseGpuCompositor(snapshot)) {
    // Conference content is overlaid on the CPU after compositing and re-draws
    // the front graphics on top of the content — so let the GPU skip the front
    // layer here to avoid a wasted full-frame blend it would only be covered.
    const VideoFrame *gpuFrontGraphics =
        (snapshot.conferenceMode && snapshot.mediaLayer.enabled)
            ? nullptr
            : frontGraphicsFrame;
    const GpuComposePlan plan = buildGpuPlan(
        options, snapshot, cameraFrame, cameraMask, effectiveBack,
        gpuFrontGraphics, frameIndex);
#if defined(__APPLE__)
    if (metalCompositorAvailable() && renderProgramFrameMetal(plan, output)) {
      drawConferenceContentOverlay(output, options, snapshot, frontGraphicsFrame);
      drawGraphics(output, options.width, options.height, snapshot.graphics);
      drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
      return "metal";
    }
#elif defined(_WIN32)
    if (d3d11CompositorAvailable() && renderProgramFrameD3D11(plan, output)) {
      drawConferenceContentOverlay(output, options, snapshot, frontGraphicsFrame);
      drawGraphics(output, options.width, options.height, snapshot.graphics);
      drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
      return "d3d11";
    }
#endif
  }
  renderProgramFrameCpu(options, snapshot, cameraFrame, cameraMask,
                        backGraphicsFrame, frontGraphicsFrame, frameIndex,
                        output);
  return "cpu";
}

GpuCompositorSelfTestResult runGpuCompositorSelfTest() {
  Options options;
  options.width = 64u;
  options.height = 36u;
  CompositorSnapshot snapshot;
  snapshot.keyerEnabled = true;
  snapshot.backgroundMode = "gradient";
  snapshot.cameraRender.enabled = true;
  snapshot.cameraRender.mirror = true;

  VideoFrame camera;
  camera.width = options.width;
  camera.height = options.height;
  camera.timestampNs = 1u;
  camera.rgba.assign(static_cast<size_t>(camera.width) * camera.height * 4u, 255u);
  for (uint32_t y = 0; y < camera.height; ++y) {
    for (uint32_t x = 0; x < camera.width; ++x) {
      const size_t offset = (static_cast<size_t>(y) * camera.width + x) * 4u;
      camera.rgba[offset + 0u] = static_cast<uint8_t>(32u + x * 3u);
      camera.rgba[offset + 1u] = static_cast<uint8_t>(40u + y * 4u);
      camera.rgba[offset + 2u] = 180u;
    }
  }

  AlphaMask mask;
  mask.width = camera.width;
  mask.height = camera.height;
  mask.timestampNs = 1u;
  mask.alpha.assign(static_cast<size_t>(mask.width) * mask.height, 0u);
  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      mask.alpha[static_cast<size_t>(y) * mask.width + x] =
          x < mask.width / 2u ? 0u : 255u;
    }
  }

  VideoFrame backGraphics;
  backGraphics.width = options.width;
  backGraphics.height = options.height;
  backGraphics.timestampNs = 2u;
  backGraphics.rgba.assign(
      static_cast<size_t>(backGraphics.width) * backGraphics.height * 4u, 0u);
  for (size_t index = 0; index < backGraphics.rgba.size(); index += 4u) {
    backGraphics.rgba[index + 2u] = 220u;
    backGraphics.rgba[index + 3u] = 48u;
  }

  VideoFrame frontGraphics;
  frontGraphics.width = options.width;
  frontGraphics.height = options.height;
  frontGraphics.timestampNs = 3u;
  frontGraphics.rgba.assign(
      static_cast<size_t>(frontGraphics.width) * frontGraphics.height * 4u, 0u);
  for (uint32_t y = options.height * 3u / 4u; y < options.height; ++y) {
    for (uint32_t x = 0; x < options.width; ++x) {
      const size_t offset = (static_cast<size_t>(y) * options.width + x) * 4u;
      frontGraphics.rgba[offset + 1u] = 240u;
      frontGraphics.rgba[offset + 3u] = 96u;
    }
  }

  std::vector<uint8_t> cpuOutput;
  renderProgramFrameCpu(options, snapshot, &camera, &mask, &backGraphics,
                        &frontGraphics, 11u, cpuOutput);
  const GpuComposePlan plan = buildGpuPlan(
      options, snapshot, &camera, &mask, &backGraphics, &frontGraphics, 11u);
  std::vector<uint8_t> gpuOutput;
  GpuCompositorSelfTestResult result;
#if defined(__APPLE__)
  result.backend = "metal";
  result.available = metalCompositorAvailable();
  result.hardwareAccelerated = result.available;
  const bool rendered = result.available && renderProgramFrameMetal(plan, gpuOutput);
#elif defined(_WIN32)
  result.backend = "d3d11";
  result.available = d3d11CompositorSelfTestAvailable();
  result.hardwareAccelerated = d3d11CompositorHardwareAccelerated();
  const bool rendered = result.available && renderProgramFrameD3D11(plan, gpuOutput);
#else
  const bool rendered = false;
#endif
  if (!rendered || gpuOutput.size() != cpuOutput.size()) {
    return result;
  }
  int maxDelta = 0;
  for (size_t index = 0; index < cpuOutput.size(); ++index) {
    const int delta = std::abs(
        static_cast<int>(cpuOutput[index]) - static_cast<int>(gpuOutput[index]));
    if (delta > maxDelta) {
      maxDelta = delta;
      const size_t pixelIndex = index / 4u;
      result.maxDeltaX = static_cast<uint32_t>(pixelIndex % options.width);
      result.maxDeltaY = static_cast<uint32_t>(pixelIndex / options.width);
      result.maxDeltaChannel = static_cast<uint32_t>(index % 4u);
      result.maxDeltaCpuValue = cpuOutput[index];
      result.maxDeltaGpuValue = gpuOutput[index];
    }
  }
  result.maxChannelDelta = maxDelta;
  CompositorSnapshot layeredSnapshot = snapshot;
  layeredSnapshot.cornerbug.enabled = true;
  layeredSnapshot.graphics.enabled = true;
  std::vector<uint8_t> layeredOutput;
  const std::string integratedBackend = renderProgramFrame(
      options, layeredSnapshot, &camera, &mask, &backGraphics, &frontGraphics,
      12u, layeredOutput);
  result.passed = maxDelta <= 2 && integratedBackend == result.backend;
  return result;
}

}  // namespace broadify::meeting
