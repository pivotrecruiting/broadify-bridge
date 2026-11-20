#include "live_stream/rgba_to_nv12.h"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "rgba_to_nv12_test failed: " << m << std::endl; std::exit(1); }

namespace {

const uint8_t kGuard = 0xA5;

struct Rgb {
  uint8_t r, g, b;
};

struct Image {
  uint32_t width, height, stride;
  std::vector<uint8_t> bytes;
};

// Padding bytes of each row carry garbage so a stride mix-up shows up in the output.
template <typename F>
Image makeImage(uint32_t width, uint32_t height, uint32_t stride, RgbaOrder order, F colourAt) {
  Image image{width, height, stride, std::vector<uint8_t>(static_cast<size_t>(stride) * height, 0xEE)};
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const Rgb c = colourAt(x, y);
      uint8_t *p = &image.bytes[static_cast<size_t>(y) * stride + 4 * x];
      p[0] = order == RgbaOrder::Rgba ? c.r : c.b;
      p[1] = c.g;
      p[2] = order == RgbaOrder::Rgba ? c.b : c.r;
      p[3] = static_cast<uint8_t>(x * 7 + y * 13);  // alpha must not matter
    }
  }
  return image;
}

struct Nv12 {
  uint32_t width, height, yStride, uvStride;
  std::vector<uint8_t> y, uv;
  Nv12(uint32_t w, uint32_t h, uint32_t ys, uint32_t uvs)
      : width(w), height(h), yStride(ys), uvStride(uvs), y(static_cast<size_t>(ys) * h, kGuard),
        uv(static_cast<size_t>(uvs) * nv12ChromaRows(h), kGuard) {}
  Nv12Planes planes() { return Nv12Planes{y.data(), yStride, uv.data(), uvStride}; }
  uint8_t lumaAt(uint32_t x, uint32_t row) const { return y[static_cast<size_t>(row) * yStride + x]; }
  uint8_t cbAt(uint32_t cx, uint32_t cy) const { return uv[static_cast<size_t>(cy) * uvStride + 2 * cx]; }
  uint8_t crAt(uint32_t cx, uint32_t cy) const { return uv[static_cast<size_t>(cy) * uvStride + 2 * cx + 1]; }
  // Bytes between the visible row and the stride must stay untouched.
  bool paddingUntouched() const {
    for (uint32_t row = 0; row < height; ++row)
      for (uint32_t x = width; x < yStride; ++x)
        if (lumaAt(x, row) != kGuard) return false;
    for (uint32_t row = 0; row < nv12ChromaRows(height); ++row)
      for (uint32_t x = 2 * nv12ChromaWidth(width); x < uvStride; ++x)
        if (uv[static_cast<size_t>(row) * uvStride + x] != kGuard) return false;
    return true;
  }
};

// Floating-point BT.709 limited-range reference.
double refY(double r, double g, double b) { return 16.0 + 219.0 / 255.0 * (0.2126 * r + 0.7152 * g + 0.0722 * b); }
double refCb(double r, double g, double b) {
  return 128.0 + 224.0 / 255.0 * (b - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 1.8556;
}
double refCr(double r, double g, double b) {
  return 128.0 + 224.0 / 255.0 * (r - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 1.5748;
}

void expectSolid(Rgb colour, uint8_t y, uint8_t cb, uint8_t cr, const char *name) {
  for (const RgbaOrder order : {RgbaOrder::Rgba, RgbaOrder::Bgra}) {
    const Image image = makeImage(8, 6, 32, order, [&](uint32_t, uint32_t) { return colour; });
    Nv12 out(8, 6, 8, 8);
    if (!rgbaToNv12(image.bytes.data(), image.stride, 8, 6, order, out.planes())) fail(name);
    for (uint32_t row = 0; row < 6; ++row)
      for (uint32_t x = 0; x < 8; ++x)
        if (out.lumaAt(x, row) != y) fail(name);
    for (uint32_t cy = 0; cy < 3; ++cy)
      for (uint32_t cx = 0; cx < 4; ++cx)
        if (out.cbAt(cx, cy) != cb || out.crAt(cx, cy) != cr) fail(name);
  }
}

// Gradient image against the floating-point reference: luma within 1 code
// value per pixel, chroma within 1 of the reference of the averaged 2x2 block.
void expectGradient(uint32_t width, uint32_t height, uint32_t srcStride, uint32_t yStride, uint32_t uvStride,
                    RgbaOrder order, const char *name) {
  const auto colourAt = [&](uint32_t x, uint32_t y) {
    return Rgb{static_cast<uint8_t>((x * 255) / (width > 1 ? width - 1 : 1)),
               static_cast<uint8_t>((y * 255) / (height > 1 ? height - 1 : 1)),
               static_cast<uint8_t>((x * 31 + y * 17) & 0xff)};
  };
  const Image image = makeImage(width, height, srcStride, order, colourAt);
  Nv12 out(width, height, yStride, uvStride);
  if (!rgbaToNv12(image.bytes.data(), image.stride, width, height, order, out.planes())) fail(name);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const Rgb c = colourAt(x, y);
      if (std::fabs(out.lumaAt(x, y) - refY(c.r, c.g, c.b)) > 1.0) fail(name);
    }
  }
  for (uint32_t cy = 0; cy < nv12ChromaRows(height); ++cy) {
    for (uint32_t cx = 0; cx < nv12ChromaWidth(width); ++cx) {
      double r = 0, g = 0, b = 0;
      for (uint32_t dy = 0; dy < 2; ++dy) {
        for (uint32_t dx = 0; dx < 2; ++dx) {
          // Odd dimensions: the missing neighbour is the edge pixel itself.
          const uint32_t x = 2 * cx + dx < width ? 2 * cx + dx : width - 1;
          const uint32_t y = 2 * cy + dy < height ? 2 * cy + dy : height - 1;
          const Rgb c = colourAt(x, y);
          r += c.r / 4.0, g += c.g / 4.0, b += c.b / 4.0;
        }
      }
      if (std::fabs(out.cbAt(cx, cy) - refCb(r, g, b)) > 1.0) fail(name);
      if (std::fabs(out.crAt(cx, cy) - refCr(r, g, b)) > 1.0) fail(name);
    }
  }
  if (!out.paddingUntouched()) fail(name);
}

}  // namespace

int main() {
  // Pure colours, BT.709 limited range (reference values from the matrix, rounded).
  expectSolid({0, 0, 0}, 16, 128, 128, "black");
  expectSolid({255, 255, 255}, 235, 128, 128, "white");
  expectSolid({255, 0, 0}, 63, 102, 240, "red");
  expectSolid({0, 255, 0}, 173, 42, 26, "green");
  expectSolid({0, 0, 255}, 32, 240, 118, "blue");
  expectSolid({255, 255, 0}, 219, 16, 138, "yellow");
  expectSolid({0, 255, 255}, 188, 154, 16, "cyan");
  expectSolid({255, 0, 255}, 78, 214, 230, "magenta");
  // Every grey is neutral: chroma exactly 128, luma on the 16-235 ramp.
  for (uint32_t v = 0; v < 256; ++v) {
    const Rgb grey{static_cast<uint8_t>(v), static_cast<uint8_t>(v), static_cast<uint8_t>(v)};
    expectSolid(grey, static_cast<uint8_t>(std::lround(16.0 + 219.0 * v / 255.0)), 128, 128, "grey ramp");
  }

  // Channel order: the same picture as RGBA and BGRA gives identical NV12.
  {
    const auto colourAt = [](uint32_t x, uint32_t y) {
      return Rgb{static_cast<uint8_t>(x * 40), static_cast<uint8_t>(y * 60), static_cast<uint8_t>(255 - x * 30)};
    };
    const Image rgba = makeImage(6, 4, 24, RgbaOrder::Rgba, colourAt);
    const Image bgra = makeImage(6, 4, 24, RgbaOrder::Bgra, colourAt);
    Nv12 a(6, 4, 6, 6), b(6, 4, 6, 6);
    if (!rgbaToNv12(rgba.bytes.data(), 24, 6, 4, RgbaOrder::Rgba, a.planes())) fail("rgba order");
    if (!rgbaToNv12(bgra.bytes.data(), 24, 6, 4, RgbaOrder::Bgra, b.planes())) fail("bgra order");
    if (a.y != b.y || a.uv != b.uv) fail("rgba and bgra must agree");
    // Reading BGRA bytes as RGBA swaps red and blue, so the result must differ.
    Nv12 c(6, 4, 6, 6);
    if (!rgbaToNv12(bgra.bytes.data(), 24, 6, 4, RgbaOrder::Rgba, c.planes())) fail("swapped order");
    if (a.uv == c.uv) fail("channel order must matter");
  }

  // Chroma is the 2x2 average: a red/blue checker pair averages before the matrix.
  {
    const Image image = makeImage(2, 2, 8, RgbaOrder::Rgba, [](uint32_t x, uint32_t) {
      return x == 0 ? Rgb{255, 0, 0} : Rgb{0, 0, 255};
    });
    Nv12 out(2, 2, 2, 2);
    if (!rgbaToNv12(image.bytes.data(), 8, 2, 2, RgbaOrder::Rgba, out.planes())) fail("2x2");
    if (out.lumaAt(0, 0) != 63 || out.lumaAt(1, 0) != 32 || out.lumaAt(0, 1) != 63 || out.lumaAt(1, 1) != 32) fail("2x2 luma");
    // (102 + 240) / 2 = 171, (240 + 118) / 2 = 179
    if (out.cbAt(0, 0) != 171 || out.crAt(0, 0) != 179) fail("2x2 chroma average");
  }

  // Gradients: tight and padded strides, odd sizes, portrait.
  expectGradient(16, 8, 64, 16, 16, RgbaOrder::Bgra, "gradient 16x8 tight");
  expectGradient(16, 8, 80, 24, 20, RgbaOrder::Rgba, "gradient 16x8 padded strides");
  expectGradient(7, 5, 28, 7, 8, RgbaOrder::Bgra, "gradient 7x5 odd");
  expectGradient(7, 5, 37, 13, 11, RgbaOrder::Rgba, "gradient 7x5 odd, unaligned strides");
  expectGradient(1, 1, 4, 1, 2, RgbaOrder::Rgba, "gradient 1x1");
  expectGradient(5, 2, 20, 5, 6, RgbaOrder::Bgra, "gradient odd width");
  expectGradient(4, 3, 16, 4, 4, RgbaOrder::Bgra, "gradient odd height");
  expectGradient(1080, 1920, 1080 * 4 + 16, 1088, 1088, RgbaOrder::Bgra, "gradient 1080x1920 portrait");
  expectGradient(1920, 1080, 1920 * 4, 1920, 1920, RgbaOrder::Bgra, "gradient 1920x1080");

  // Rejected input leaves the destination untouched.
  {
    const Image image = makeImage(4, 4, 16, RgbaOrder::Rgba, [](uint32_t, uint32_t) { return Rgb{1, 2, 3}; });
    Nv12 out(4, 4, 4, 4);
    Nv12Planes p = out.planes();
    if (rgbaToNv12(nullptr, 16, 4, 4, RgbaOrder::Rgba, p)) fail("null source");
    if (rgbaToNv12(image.bytes.data(), 16, 0, 4, RgbaOrder::Rgba, p)) fail("zero width");
    if (rgbaToNv12(image.bytes.data(), 16, 4, 0, RgbaOrder::Rgba, p)) fail("zero height");
    if (rgbaToNv12(image.bytes.data(), 15, 4, 4, RgbaOrder::Rgba, p)) fail("short source stride");
    Nv12Planes shortY = p; shortY.yStride = 3;
    if (rgbaToNv12(image.bytes.data(), 16, 4, 4, RgbaOrder::Rgba, shortY)) fail("short luma stride");
    Nv12Planes shortUv = p; shortUv.uvStride = 3;
    if (rgbaToNv12(image.bytes.data(), 16, 4, 4, RgbaOrder::Rgba, shortUv)) fail("short chroma stride");
    Nv12Planes noUv = p; noUv.uv = nullptr;
    if (rgbaToNv12(image.bytes.data(), 16, 4, 4, RgbaOrder::Rgba, noUv)) fail("null chroma plane");
    // Odd width needs room for the rounded-up chroma column.
    Nv12 odd(5, 2, 5, 6);
    Nv12Planes oddShort = odd.planes(); oddShort.uvStride = 5;
    const Image wide = makeImage(5, 2, 20, RgbaOrder::Rgba, [](uint32_t, uint32_t) { return Rgb{1, 2, 3}; });
    if (rgbaToNv12(wide.bytes.data(), 20, 5, 2, RgbaOrder::Rgba, oddShort)) fail("odd width with short chroma stride");
    for (uint8_t v : out.y) if (v != kGuard) fail("rejected call wrote luma");
    for (uint8_t v : out.uv) if (v != kGuard) fail("rejected call wrote chroma");
    for (uint8_t v : odd.uv) if (v != kGuard) fail("rejected odd call wrote chroma");
  }

  std::cout << "rgba_to_nv12_test passed" << std::endl;
  return 0;
}
