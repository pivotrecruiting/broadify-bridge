#include "compose/compositor.h"
#if defined(__APPLE__)
#include "compose/metal_compositor.h"
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

// Exact round(value / 255) without an integer division; blendPixel runs
// millions of times per frame across all layers, so divisions dominate.
uint32_t div255(uint32_t value) {
  return (value + 128u + ((value + 128u) >> 8u)) >> 8u;
}

void blendPixel(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  if (a == 0u) {
    return;
  }
  if (x < 0 || y < 0 || x >= static_cast<int>(width) || y >= static_cast<int>(height)) {
    return;
  }
  const size_t offset = (static_cast<size_t>(y) * width + static_cast<uint32_t>(x)) * 4u;
  if (a == 255u) {
    frame[offset + 0] = r;
    frame[offset + 1] = g;
    frame[offset + 2] = b;
    frame[offset + 3] = 255u;
    return;
  }
  const uint32_t inverseAlpha = 255u - a;
  frame[offset + 0] = static_cast<uint8_t>(div255(r * a + frame[offset + 0] * inverseAlpha));
  frame[offset + 1] = static_cast<uint8_t>(div255(g * a + frame[offset + 1] * inverseAlpha));
  frame[offset + 2] = static_cast<uint8_t>(div255(b * a + frame[offset + 2] * inverseAlpha));
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

// Cached loader for the uploaded company background image (single slot,
// same pattern as the media layer image cache).
std::shared_ptr<const RgbaImage> getBackgroundImage(const std::string &path) {
  static std::string cachedPath;
  static std::shared_ptr<const RgbaImage> cachedImage;
  if (path.empty()) {
    return nullptr;
  }
  if (path == cachedPath) {
    return cachedImage;
  }
  std::ifstream file(path, std::ios::binary);
  cachedPath = path;
  if (!file.good()) {
    cachedImage = nullptr;
    return nullptr;
  }
  const std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  cachedImage = decodeImageBytes(bytes);
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

void fillGradientBackground(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, uint64_t frameIndex) {
  frame.resize(static_cast<size_t>(width) * height * 4u);
  std::vector<uint8_t> redBase(width);
  for (uint32_t x = 0; x < width; ++x) {
    redBase[x] = static_cast<uint8_t>((120u * x) / std::max<uint32_t>(1, width));
  }
  uint8_t *pixel = frame.data();
  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t green = clampByte(54 + static_cast<int>((90.0 * y) / std::max<uint32_t>(1, height)));
    int wave = static_cast<int>((y + frameIndex) % 96u);
    for (uint32_t x = 0; x < width; ++x) {
      pixel[0] = clampByte(20 + redBase[x] + wave / 5);
      pixel[1] = green;
      pixel[2] = clampByte(94 + wave);
      pixel[3] = 255u;
      pixel += 4;
      wave = wave + 1 == 96 ? 0 : wave + 1;
    }
  }
}

// Static background modes never change between frames; render them once per
// (mode, size) and reuse the buffer instead of looping over ~1M pixels at
// frame rate. Only the animated gradient is regenerated each frame. The cache
// is safe without locking because renderProgramFrame runs on a single thread.
void fillBackground(std::vector<uint8_t> &frame, uint32_t width, uint32_t height, const std::string &mode, uint64_t frameIndex) {
  if (mode == "gradient") {
    fillGradientBackground(frame, width, height, frameIndex);
    return;
  }

  static std::string cachedMode;
  static uint32_t cachedWidth = 0;
  static uint32_t cachedHeight = 0;
  static std::vector<uint8_t> cachedPixels;

  if (cachedMode != mode || cachedWidth != width || cachedHeight != height) {
    cachedPixels.resize(static_cast<size_t>(width) * height * 4u);
    uint8_t *pixel = cachedPixels.data();
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        uint8_t r = 8;
        uint8_t g = 10;
        uint8_t b = 14;
        if (mode == "solid_light") {
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
        pixel[0] = r;
        pixel[1] = g;
        pixel[2] = b;
        pixel[3] = 255u;
        pixel += 4;
      }
    }
    cachedMode = mode;
    cachedWidth = width;
    cachedHeight = height;
  }

  frame = cachedPixels;
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

bool frameHasTransparency(const VideoFrame *frame) {
  if (frame == nullptr || frame->rgba.empty()) {
    return false;
  }
  const size_t pixelCount = frame->rgba.size() / 4u;
  if (pixelCount == 0u) {
    return false;
  }
  const size_t stride = std::max<size_t>(1u, pixelCount / 4096u);
  for (size_t pixel = 0u; pixel < pixelCount; pixel += stride) {
    if (frame->rgba[pixel * 4u + 3u] < 250u) {
      return true;
    }
  }
  const size_t lastAlpha = (pixelCount - 1u) * 4u + 3u;
  return frame->rgba[lastAlpha] < 250u;
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
    // The rectangular drop shadow only matches a planar panel; behind an
    // X/Y-rotated (perspective) panel it reads as a frontal "ghost", so it
    // is skipped there.
    if (std::abs(mediaLayer.rotationX) < 0.001 && std::abs(mediaLayer.rotationY) < 0.001) {
      fillRotatedRect(frame, width, height, {rect.x + 8, rect.y + 10, rect.width, rect.height}, mediaLayer.rotation, 0, 0, 0, 46);
    }
    drawImageFitRotated(frame, width, height, rect, *image, mediaLayer.rotationX, mediaLayer.rotationY, mediaLayer.rotation);
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
  // Match the builder preview, which sizes the logo as a percentage of the
  // canvas *width* (slider range up to 40%); min(width, height) rendered the
  // logo ~44% smaller on-air than in the preview on 16:9 canvases.
  const int size = static_cast<int>(width * std::clamp(cornerbug.size, 0.04, 0.40));
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

// CPU fallback for scenes the GPU compositor does not cover: applies the
// keyer mask (bilinear, same normalize curve as the former worker-side pass)
// onto a scratch copy of the camera frame.
void applyMaskToFrameCpu(VideoFrame &frame, const AlphaMask &mask) {
  if (frame.rgba.empty() || mask.alpha.empty() || mask.width == 0u || mask.height == 0u) {
    return;
  }
  for (uint32_t y = 0; y < frame.height; ++y) {
    const double srcY = ((y + 0.5) / frame.height) * mask.height - 0.5;
    const uint32_t y0 = static_cast<uint32_t>(std::clamp<int>(static_cast<int>(std::floor(srcY)), 0, static_cast<int>(mask.height) - 1));
    const uint32_t y1 = std::min(y0 + 1u, mask.height - 1u);
    const double wy = std::clamp(srcY - std::floor(srcY), 0.0, 1.0);
    for (uint32_t x = 0; x < frame.width; ++x) {
      const double srcX = ((x + 0.5) / frame.width) * mask.width - 0.5;
      const uint32_t x0 = static_cast<uint32_t>(std::clamp<int>(static_cast<int>(std::floor(srcX)), 0, static_cast<int>(mask.width) - 1));
      const uint32_t x1 = std::min(x0 + 1u, mask.width - 1u);
      const double wx = std::clamp(srcX - std::floor(srcX), 0.0, 1.0);
      const double top = mask.alpha[static_cast<size_t>(y0) * mask.width + x0] * (1.0 - wx) +
                         mask.alpha[static_cast<size_t>(y0) * mask.width + x1] * wx;
      const double bottom = mask.alpha[static_cast<size_t>(y1) * mask.width + x0] * (1.0 - wx) +
                            mask.alpha[static_cast<size_t>(y1) * mask.width + x1] * wx;
      const double raw = top * (1.0 - wy) + bottom * wy;
      double alpha = 0.0;
      if (raw > 18.0) {
        if (raw >= 242.0) {
          alpha = 255.0;
        } else {
          const double t = (raw - 18.0) / 224.0;
          alpha = t * t * (3.0 - 2.0 * t) * 255.0;
        }
      }
      const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      const uint8_t a = clampByte(static_cast<int>(std::round(alpha)));
      frame.rgba[offset + 3u] = a;
      if (a == 0u) {
        frame.rgba[offset + 0u] = 0u;
        frame.rgba[offset + 1u] = 0u;
        frame.rgba[offset + 2u] = 0u;
      }
    }
  }
}

}  // namespace

CompositorSnapshot copyCompositorSnapshot(const MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  CompositorSnapshot snapshot;
  snapshot.keyerEnabled = state.keyerEnabled;
  snapshot.backgroundMode = state.backgroundMode;
  snapshot.backgroundImagePath = state.backgroundImagePath;
  snapshot.speakerLayout = state.speakerLayout;
  snapshot.cornerbug = state.cornerbug;
  snapshot.mediaLayer = state.mediaLayer;
  snapshot.graphics = state.graphics;
  snapshot.cameraRender = state.cameraRender;
  return snapshot;
}



// Bottom anchor for the keyed presenter: the lowest row containing at least
// this many keyed pixels. Anchoring on the single bottom-most keyed pixel
// lets isolated mask-noise pixels re-anchor (and visibly shift) the whole
// presenter between frames.
constexpr int kKeyedAnchorMinRowPixels = 8;

int keyedAnchorBottomY(const VideoFrame &frame) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return -1;
  }
  int fallbackBottomY = -1;
  for (int sourceY = static_cast<int>(frame.height) - 1; sourceY >= 0; --sourceY) {
    const uint8_t *alphaRow =
        frame.rgba.data() + static_cast<size_t>(sourceY) * frame.width * 4u + 3u;
    int rowCount = 0;
    for (uint32_t sourceX = 0; sourceX < frame.width; ++sourceX) {
      if (alphaRow[static_cast<size_t>(sourceX) * 4u] > 24u) {
        ++rowCount;
        if (rowCount >= kKeyedAnchorMinRowPixels) {
          return sourceY;
        }
      }
    }
    if (rowCount > 0 && fallbackBottomY < 0) {
      fallbackBottomY = sourceY;
    }
  }
  return fallbackBottomY;
}

void drawKeyedPresenterLayer(std::vector<uint8_t> &frame,
                             uint32_t width,
                             uint32_t height,
                             const VideoFrame *cameraFrame,
                             const SpeakerLayoutState &speakerLayout,
                             bool mirror) {
  if (cameraFrame == nullptr || cameraFrame->rgba.empty() || cameraFrame->width == 0u || cameraFrame->height == 0u) {
    return;
  }

  const int canvasWidth = static_cast<int>(width);
  const int canvasHeight = static_cast<int>(height);
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return;
  }

  // Broadcast behavior:
  // Draw only keyed alpha pixels. Do not draw/crop/move a camera rectangle.
  // Vertical preset scaling is anchored to the keyed person's bottom edge so
  // the body stays bündig with the lower program edge instead of floating.
  constexpr uint8_t kPresenterAlphaDrawThreshold = 24u;

  // Single pass over the alpha channel: bounding box of all keyed pixels.
  // The subsequent splat loop then only visits that box instead of the full
  // frame, and the bottom edge doubles as the vertical anchor.
  int minSourceX = static_cast<int>(cameraFrame->width);
  int maxSourceX = -1;
  int minSourceY = -1;
  int keyedAlphaBottomY = -1;
  for (uint32_t sourceY = 0; sourceY < cameraFrame->height; ++sourceY) {
    const uint8_t *alphaRow = cameraFrame->rgba.data() + static_cast<size_t>(sourceY) * cameraFrame->width * 4u + 3u;
    int rowMin = -1;
    int rowMax = -1;
    for (uint32_t sourceX = 0; sourceX < cameraFrame->width; ++sourceX) {
      if (alphaRow[static_cast<size_t>(sourceX) * 4u] > kPresenterAlphaDrawThreshold) {
        if (rowMin < 0) {
          rowMin = static_cast<int>(sourceX);
        }
        rowMax = static_cast<int>(sourceX);
      }
    }
    if (rowMin >= 0) {
      minSourceX = std::min(minSourceX, rowMin);
      maxSourceX = std::max(maxSourceX, rowMax);
      if (minSourceY < 0) {
        minSourceY = static_cast<int>(sourceY);
      }
      keyedAlphaBottomY = static_cast<int>(sourceY);
    }
  }

  if (keyedAlphaBottomY < 0) {
    return;
  }

  const int anchorBottomY = keyedAnchorBottomY(*cameraFrame);
  if (anchorBottomY < 0) {
    return;
  }

  const double scale = speakerLayout.enabled ? std::clamp(speakerLayout.scale, 0.4, 1.8) : 1.0;
  double offsetX = 0.0;

  if (speakerLayout.enabled) {
    const double horizontalTravel = static_cast<double>(canvasWidth) * 0.22;
    if (speakerLayout.layout == "left") {
      offsetX -= horizontalTravel;
    } else if (speakerLayout.layout == "right") {
      offsetX += horizontalTravel;
    }
  }

  const double sourceCenterX = static_cast<double>(cameraFrame->width) * 0.5;
  const double sourceCenterY = static_cast<double>(cameraFrame->height) * 0.5;
  const double sourceToCanvasX = static_cast<double>(canvasWidth) / static_cast<double>(cameraFrame->width);
  const double sourceToCanvasY = static_cast<double>(canvasHeight) / static_cast<double>(cameraFrame->height);

  const double targetCenterX = static_cast<double>(canvasWidth) * 0.5 + offsetX;
  const double targetBottomY = static_cast<double>(canvasHeight) - 0.5;
  const double targetCenterY =
      targetBottomY -
      ((static_cast<double>(anchorBottomY) + 0.5 - sourceCenterY) * sourceToCanvasY * scale);

  const int splatWidth = std::max(1, static_cast<int>(std::ceil(scale * sourceToCanvasX)));
  const int splatHeight = std::max(1, static_cast<int>(std::ceil(scale * sourceToCanvasY)));

  // Destination coordinates depend only on the source column/row; compute
  // them once per column instead of per pixel.
  std::vector<int> destX0BySourceX(static_cast<size_t>(maxSourceX - minSourceX + 1));
  for (int sourceX = minSourceX; sourceX <= maxSourceX; ++sourceX) {
    const double displaySourceX = mirror
        ? static_cast<double>(static_cast<int>(cameraFrame->width) - 1 - sourceX)
        : static_cast<double>(sourceX);
    const double destXCenter =
        targetCenterX +
        ((displaySourceX + 0.5 - sourceCenterX) * sourceToCanvasX * scale);
    destX0BySourceX[static_cast<size_t>(sourceX - minSourceX)] =
        static_cast<int>(std::floor(destXCenter - static_cast<double>(splatWidth) * 0.5));
  }

  for (int sourceY = minSourceY; sourceY <= keyedAlphaBottomY; ++sourceY) {
    const double destYCenter =
        targetCenterY +
        ((static_cast<double>(sourceY) + 0.5 - sourceCenterY) * sourceToCanvasY * scale);
    const int destY0 = static_cast<int>(std::floor(destYCenter - static_cast<double>(splatHeight) * 0.5));

    const uint8_t *sourceRow = cameraFrame->rgba.data() + static_cast<size_t>(sourceY) * cameraFrame->width * 4u;
    for (int sourceX = minSourceX; sourceX <= maxSourceX; ++sourceX) {
      const size_t srcOffset = static_cast<size_t>(sourceX) * 4u;
      const uint8_t alpha = sourceRow[srcOffset + 3u];
      if (alpha <= kPresenterAlphaDrawThreshold) {
        continue;
      }

      const int destX0 = destX0BySourceX[static_cast<size_t>(sourceX - minSourceX)];
      for (int dy = 0; dy < splatHeight; ++dy) {
        const int destY = destY0 + dy;
        if (destY < 0 || destY >= canvasHeight) {
          continue;
        }
        for (int dx = 0; dx < splatWidth; ++dx) {
          const int destX = destX0 + dx;
          if (destX < 0 || destX >= canvasWidth) {
            continue;
          }
          blendPixel(frame, width, height, destX, destY,
                     sourceRow[srcOffset + 0u],
                     sourceRow[srcOffset + 1u],
                     sourceRow[srcOffset + 2u],
                     alpha);
        }
      }
    }
  }
}





#if defined(__APPLE__)
namespace {

int backgroundModeCode(const std::string &mode) {
  if (mode == "gradient") {
    return 1;
  }
  if (mode == "solid_light") {
    return 2;
  }
  if (mode == "checkerboard") {
    return 3;
  }
  if (mode == "transparent") {
    return 4;
  }
  return 0;
}

MetalLayerMapping coverMapping(const VideoFrame &frame, uint32_t canvasWidth, uint32_t canvasHeight) {
  const SourceRect source = coverSourceRect(
      frame.width, frame.height, static_cast<int>(canvasWidth), static_cast<int>(canvasHeight));
  MetalLayerMapping mapping;
  mapping.present = true;
  mapping.scaleX = static_cast<float>(source.width) / static_cast<float>(std::max<uint32_t>(1, canvasWidth));
  mapping.scaleY = static_cast<float>(source.height) / static_cast<float>(std::max<uint32_t>(1, canvasHeight));
  mapping.biasX = static_cast<float>(source.x) - 0.5f;
  mapping.biasY = static_cast<float>(source.y) - 0.5f;
  mapping.mirrorConst = static_cast<float>(2u * source.x + source.width) - 1.0f;
  return mapping;
}


// Inverse homography (dest px -> uv in [0,1]) for a projected quad whose
// corners correspond to uv (0,0),(1,0),(1,1),(0,1). Same math as the CPU
// perspective path in drawImageFitRotated.
bool quadInverseHomography(const double quadX[4], const double quadY[4], float out[9]) {
  const double dx1 = quadX[1] - quadX[2];
  const double dx2 = quadX[3] - quadX[2];
  const double dx3 = quadX[0] - quadX[1] + quadX[2] - quadX[3];
  const double dy1 = quadY[1] - quadY[2];
  const double dy2 = quadY[3] - quadY[2];
  const double dy3 = quadY[0] - quadY[1] + quadY[2] - quadY[3];
  const double den = dx1 * dy2 - dx2 * dy1;
  if (std::abs(den) < 1e-9) {
    return false;
  }
  const double g = (dx3 * dy2 - dx2 * dy3) / den;
  const double h = (dx1 * dy3 - dx3 * dy1) / den;
  const double a = quadX[1] - quadX[0] + g * quadX[1];
  const double b = quadX[3] - quadX[0] + h * quadX[3];
  const double c = quadX[0];
  const double d = quadY[1] - quadY[0] + g * quadY[1];
  const double e = quadY[3] - quadY[0] + h * quadY[3];
  const double f = quadY[0];
  out[0] = static_cast<float>(e - f * h);
  out[1] = static_cast<float>(c * h - b);
  out[2] = static_cast<float>(b * f - c * e);
  out[3] = static_cast<float>(f * g - d);
  out[4] = static_cast<float>(a - c * g);
  out[5] = static_cast<float>(c * d - a * f);
  out[6] = static_cast<float>(d * h - e * g);
  out[7] = static_cast<float>(b * g - a * h);
  out[8] = static_cast<float>(a * e - b * d);
  return true;
}

// Projected corners of the fitted media image inside `target`, rotated on
// all three axes with the same perspective as drawImageFitRotated.
bool projectedMediaQuad(const Rect &target, uint32_t imageWidth, uint32_t imageHeight,
                        double rotXDeg, double rotYDeg, double rotZDeg,
                        double quadX[4], double quadY[4]) {
  if (target.width <= 0 || target.height <= 0 || imageWidth == 0u || imageHeight == 0u) {
    return false;
  }
  const double scale = std::min(
      static_cast<double>(target.width) / imageWidth,
      static_cast<double>(target.height) / imageHeight);
  const double drawWidth = std::max(1.0, imageWidth * scale);
  const double drawHeight = std::max(1.0, imageHeight * scale);
  const double halfW = drawWidth / 2.0;
  const double halfH = drawHeight / 2.0;
  const double centerX = target.x + target.width / 2.0;
  const double centerY = target.y + target.height / 2.0;
  constexpr double kPi = 3.14159265358979323846;
  const double ca = std::cos(rotXDeg * kPi / 180.0), sa = std::sin(rotXDeg * kPi / 180.0);
  const double cb = std::cos(rotYDeg * kPi / 180.0), sb = std::sin(rotYDeg * kPi / 180.0);
  const double cc = std::cos(rotZDeg * kPi / 180.0), sc = std::sin(rotZDeg * kPi / 180.0);
  const double m00 = cb * cc, m01 = -cb * sc;
  const double m10 = ca * sc + sa * sb * cc, m11 = ca * cc - sa * sb * sc;
  const double m20 = sa * sc - ca * sb * cc, m21 = sa * cc + ca * sb * sc;
  const bool depth = std::abs(rotXDeg) >= 0.001 || std::abs(rotYDeg) >= 0.001;
  const double d = 3.0 * std::max(drawWidth, drawHeight);
  const double lx[4] = {-halfW, halfW, halfW, -halfW};
  const double ly[4] = {-halfH, -halfH, halfH, halfH};
  for (int i = 0; i < 4; ++i) {
    const double X = m00 * lx[i] + m01 * ly[i];
    const double Y = m10 * lx[i] + m11 * ly[i];
    const double Z = m20 * lx[i] + m21 * ly[i];
    double projection = 1.0;
    if (depth) {
      const double denom = d - Z;
      if (denom <= 1.0) {
        return false;
      }
      projection = d / denom;
    }
    quadX[i] = centerX + X * projection;
    quadY[i] = centerY + Y * projection;
  }
  return true;
}

// Presenter bottom anchor from the mask (raw values), scaled to frame rows.
int maskAnchorBottomFrameY(const AlphaMask &mask, uint32_t frameHeight) {
  int fallbackRow = -1;
  for (int my = static_cast<int>(mask.height) - 1; my >= 0; --my) {
    const uint8_t *row = mask.alpha.data() + static_cast<size_t>(my) * mask.width;
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
      fallbackRow = static_cast<int>(((my + 0.5) * frameHeight) / mask.height);
    }
  }
  return fallbackRow;
}

// GPU stage 1: composites background, back/front graphics and the camera
// layer (keyed presenter or cover camera) on the GPU. Scenes with layers the
// GPU path does not cover yet (media layer, built-in lower third) fall back
// to the CPU compositor; the cornerbug is drawn on the CPU on top of the GPU
// result, which matches its position as the topmost layer.
bool tryRenderProgramFrameMetal(const Options &options,
                                const CompositorSnapshot &snapshot,
                                const VideoFrame *cameraFrame,
                                const AlphaMask *cameraMask,
                                const VideoFrame *backGraphicsFrame,
                                const VideoFrame *frontGraphicsFrame,
                                uint64_t frameIndex,
                                std::vector<uint8_t> &output) {
  if (!metalCompositorAvailable()) {
    return false;
  }
  if (snapshot.graphics.enabled) {
    return false;
  }

  MetalComposePlan plan;
  plan.width = options.width;
  plan.height = options.height;
  plan.backgroundMode = backgroundModeCode(snapshot.backgroundMode);
  plan.frameIndex = frameIndex;

  std::shared_ptr<const RgbaImage> backgroundImage = getBackgroundImage(snapshot.backgroundImagePath);
  if (backgroundImage != nullptr) {
    plan.backgroundImage = backgroundImage->rgba.data();
    plan.backgroundImageWidth = backgroundImage->width;
    plan.backgroundImageHeight = backgroundImage->height;
    plan.backgroundImageCacheKey = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(backgroundImage.get()));
    VideoFrame mappingFrame;
    mappingFrame.width = backgroundImage->width;
    mappingFrame.height = backgroundImage->height;
    plan.backgroundImageMapping = coverMapping(mappingFrame, plan.width, plan.height);
  }

  if (backGraphicsFrame != nullptr && !backGraphicsFrame->rgba.empty()) {
    plan.backGraphics = backGraphicsFrame;
    plan.backMapping = coverMapping(*backGraphicsFrame, plan.width, plan.height);
  }
  if (frontGraphicsFrame != nullptr && !frontGraphicsFrame->rgba.empty()) {
    plan.frontGraphics = frontGraphicsFrame;
    plan.frontMapping = coverMapping(*frontGraphicsFrame, plan.width, plan.height);
  }

  // Media (PiP/fullscreen) layer on the GPU; the glass placeholder (no image
  // yet) still falls back to the CPU path.
  std::shared_ptr<const RgbaImage> mediaImage;
  if (snapshot.mediaLayer.enabled) {
    mediaImage = getMediaLayerImage(snapshot.mediaLayer);
    if (mediaImage == nullptr) {
      return false;
    }
    Rect rect;
    if (snapshot.mediaLayer.mode == "fullscreen") {
      rect = {0, 0, static_cast<int>(plan.width), static_cast<int>(plan.height)};
    } else {
      rect = {
        static_cast<int>(plan.width * clamp01(snapshot.mediaLayer.x)),
        static_cast<int>(plan.height * clamp01(snapshot.mediaLayer.y)),
        static_cast<int>(plan.width * std::clamp(snapshot.mediaLayer.width, 0.05, 1.0)),
        static_cast<int>(plan.height * std::clamp(snapshot.mediaLayer.height, 0.05, 1.0)),
      };
    }
    double quadX[4];
    double quadY[4];
    if (!projectedMediaQuad(rect, mediaImage->width, mediaImage->height,
                            snapshot.mediaLayer.rotationX, snapshot.mediaLayer.rotationY,
                            snapshot.mediaLayer.rotation, quadX, quadY) ||
        !quadInverseHomography(quadX, quadY, plan.media.invHomography)) {
      return false;
    }
    const bool depthRotated =
        std::abs(snapshot.mediaLayer.rotationX) >= 0.001 || std::abs(snapshot.mediaLayer.rotationY) >= 0.001;
    if (!depthRotated) {
      // Planar drop shadow: the target rect rotated around its center by Z,
      // offset by (8, 10) - same as the CPU path.
      const Rect shadowRect{rect.x + 8, rect.y + 10, rect.width, rect.height};
      double shadowX[4];
      double shadowY[4];
      if (projectedMediaQuad(shadowRect, static_cast<uint32_t>(shadowRect.width),
                             static_cast<uint32_t>(shadowRect.height), 0.0, 0.0,
                             snapshot.mediaLayer.rotation, shadowX, shadowY) &&
          quadInverseHomography(shadowX, shadowY, plan.media.shadowInvHomography)) {
        plan.media.shadowPresent = true;
      }
    }
    plan.media.present = true;
    plan.media.rgba = mediaImage->rgba.data();
    plan.media.width = mediaImage->width;
    plan.media.height = mediaImage->height;
    plan.media.cacheKey = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(mediaImage.get()));
  }

  const bool hasCameraFrame = snapshot.cameraRender.enabled && cameraFrame != nullptr &&
      !cameraFrame->rgba.empty() && cameraFrame->width > 0u && cameraFrame->height > 0u;
  if (hasCameraFrame) {
    const bool keyedCameraFrame = snapshot.keyerEnabled && cameraMask != nullptr &&
        !cameraMask->alpha.empty() && cameraMask->width > 0u && cameraMask->height > 0u;
    plan.media.belowCamera = keyedCameraFrame;
    if (keyedCameraFrame) {
      plan.cameraMask = cameraMask->alpha.data();
      plan.maskWidth = cameraMask->width;
      plan.maskHeight = cameraMask->height;
      plan.maskTimestampNs = cameraMask->timestampNs;
      const int keyedAlphaBottomY = maskAnchorBottomFrameY(*cameraMask, cameraFrame->height);
      if (keyedAlphaBottomY >= 0) {
        const double scale =
            snapshot.speakerLayout.enabled ? std::clamp(snapshot.speakerLayout.scale, 0.4, 1.8) : 1.0;
        double offsetX = 0.0;
        if (snapshot.speakerLayout.enabled) {
          const double horizontalTravel = static_cast<double>(plan.width) * 0.22;
          if (snapshot.speakerLayout.layout == "left") {
            offsetX -= horizontalTravel;
          } else if (snapshot.speakerLayout.layout == "right") {
            offsetX += horizontalTravel;
          }
        }
        const double sourceCenterX = static_cast<double>(cameraFrame->width) * 0.5;
        const double sourceCenterY = static_cast<double>(cameraFrame->height) * 0.5;
        const double kx = (static_cast<double>(plan.width) / cameraFrame->width) * scale;
        const double ky = (static_cast<double>(plan.height) / cameraFrame->height) * scale;
        const double targetCenterX = static_cast<double>(plan.width) * 0.5 + offsetX;
        const double targetBottomY = static_cast<double>(plan.height) - 0.5;
        const double targetCenterY =
            targetBottomY - ((static_cast<double>(keyedAlphaBottomY) + 0.5 - sourceCenterY) * ky);

        // Invert destX = targetCenterX + (src + 0.5 - sourceCenterX) * kx.
        plan.cameraFrame = cameraFrame;
        plan.camera.present = true;
        plan.camera.keyed = true;
        plan.camera.mirror = snapshot.cameraRender.mirror;
        plan.camera.scaleX = static_cast<float>(1.0 / kx);
        plan.camera.scaleY = static_cast<float>(1.0 / ky);
        plan.camera.biasX = static_cast<float>(sourceCenterX - 0.5 - targetCenterX / kx);
        plan.camera.biasY = static_cast<float>(sourceCenterY - 0.5 - targetCenterY / ky);
        plan.camera.mirrorConst = static_cast<float>(cameraFrame->width) - 1.0f;
      }
    } else {
      plan.cameraFrame = cameraFrame;
      plan.camera = coverMapping(*cameraFrame, plan.width, plan.height);
      plan.camera.keyed = false;
      plan.camera.mirror = snapshot.cameraRender.mirror;
    }
  }

  if (!renderProgramFrameMetal(plan, output)) {
    return false;
  }
  drawCornerbug(output, plan.width, plan.height, snapshot.cornerbug);
  return true;
}

}  // namespace
#endif

void renderProgramFrame(const Options &options,
                        const CompositorSnapshot &snapshot,
                        const VideoFrame *cameraFrame,
                        const AlphaMask *cameraMask,
                        const VideoFrame *backGraphicsFrame,
                        const VideoFrame *frontGraphicsFrame,
                        uint64_t frameIndex,
                        std::vector<uint8_t> &output) {
#if defined(__APPLE__)
  if (tryRenderProgramFrameMetal(
          options, snapshot, cameraFrame, cameraMask, backGraphicsFrame, frontGraphicsFrame, frameIndex, output)) {
    return;
  }
#endif
  VideoFrame keyedScratch;
  if (cameraFrame != nullptr && cameraMask != nullptr && !cameraMask->alpha.empty() && snapshot.keyerEnabled) {
    keyedScratch = *cameraFrame;
    applyMaskToFrameCpu(keyedScratch, *cameraMask);
    cameraFrame = &keyedScratch;
  }
  fillBackground(output, options.width, options.height, snapshot.backgroundMode, frameIndex);
  if (const auto backgroundImage = getBackgroundImage(snapshot.backgroundImagePath)) {
    // Cover-fit the company background under all other layers.
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

  const Rect fullFrame{0, 0, static_cast<int>(options.width), static_cast<int>(options.height)};
  const bool cameraFrameHasAlpha = frameHasTransparency(cameraFrame);
  const bool keyedCameraFrame = snapshot.keyerEnabled && cameraFrameHasAlpha;
  const bool mediaLayerIsPip = snapshot.mediaLayer.enabled && snapshot.mediaLayer.mode == "pip";
  const bool mediaLayerIsFullscreen = snapshot.mediaLayer.enabled && snapshot.mediaLayer.mode == "fullscreen";

  // Back graphics are treated as a background/backplate layer.
  // They must never cover PiP, Camera/Key, normal graphics or cornerbug.
  drawGraphicsFrame(output, options.width, options.height, backGraphicsFrame);

  if (keyedCameraFrame) {
    // Keyer ON with a real alpha frame:
    // Background/backplate -> fullscreen background media -> PiP -> keyed presenter -> Graphics -> Cornerbug.
    if (mediaLayerIsFullscreen) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
    if (mediaLayerIsPip) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
    if (snapshot.cameraRender.enabled) {
      drawKeyedPresenterLayer(
          output,
          options.width,
          options.height,
          cameraFrame,
          snapshot.speakerLayout,
          snapshot.cameraRender.mirror);
    }
  } else {
    // Keyer OFF or Keyer fallback/passthrough:
    // Camera is the base layer and must always stay full-frame.
    if (snapshot.cameraRender.enabled) {
      drawCamera(
          output,
          options.width,
          options.height,
          fullFrame,
          cameraFrame,
          snapshot.cameraRender.mirror);
    }
    if (mediaLayerIsPip) {
      drawMediaLayer(output, options.width, options.height, snapshot.mediaLayer);
    }
  }

  drawGraphics(output, options.width, options.height, snapshot.graphics);
  drawGraphicsFrame(output, options.width, options.height, frontGraphicsFrame);
  drawCornerbug(output, options.width, options.height, snapshot.cornerbug);
}

}  // namespace broadify::meeting
