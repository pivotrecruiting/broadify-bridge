#include "live_stream/nv12_scale.h"

#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "nv12_scale_test failed: " << m << std::endl; std::exit(1); }

namespace {

const uint8_t kGuard = 0xA5;

struct Nv12 {
  uint32_t width, height, yStride, uvStride;
  std::vector<uint8_t> y, uv;
  Nv12(uint32_t w, uint32_t h, uint32_t ys, uint32_t uvs)
      : width(w), height(h), yStride(ys), uvStride(uvs), y(static_cast<size_t>(ys) * h, kGuard),
        uv(static_cast<size_t>(uvs) * nv12ChromaRows(h), kGuard) {}
  Nv12Planes planes() { return Nv12Planes{y.data(), yStride, uv.data(), uvStride}; }
  Nv12ConstPlanes constPlanes() const { return Nv12ConstPlanes{y.data(), yStride, uv.data(), uvStride}; }
  uint8_t &lumaAt(uint32_t x, uint32_t row) { return y[static_cast<size_t>(row) * yStride + x]; }
  uint8_t &cbAt(uint32_t cx, uint32_t cy) { return uv[static_cast<size_t>(cy) * uvStride + 2 * cx]; }
  uint8_t &crAt(uint32_t cx, uint32_t cy) { return uv[static_cast<size_t>(cy) * uvStride + 2 * cx + 1]; }
  template <typename FY, typename FCb, typename FCr>
  void fill(FY luma, FCb cb, FCr cr) {
    for (uint32_t row = 0; row < height; ++row)
      for (uint32_t x = 0; x < width; ++x) lumaAt(x, row) = luma(x, row);
    for (uint32_t cy = 0; cy < nv12ChromaRows(height); ++cy)
      for (uint32_t cx = 0; cx < nv12ChromaWidth(width); ++cx) cbAt(cx, cy) = cb(cx, cy), crAt(cx, cy) = cr(cx, cy);
  }
  bool paddingUntouched() const {
    for (uint32_t row = 0; row < height; ++row)
      for (uint32_t x = width; x < yStride; ++x)
        if (y[static_cast<size_t>(row) * yStride + x] != kGuard) return false;
    for (uint32_t row = 0; row < nv12ChromaRows(height); ++row)
      for (uint32_t x = 2 * nv12ChromaWidth(width); x < uvStride; ++x)
        if (uv[static_cast<size_t>(row) * uvStride + x] != kGuard) return false;
    return true;
  }
};

int absDiff(int a, int b) { return a > b ? a - b : b - a; }

// A solid frame stays solid at any size: no drift from the weights, no bleed from row padding.
void expectSolid(uint32_t sw, uint32_t sh, uint32_t sys, uint32_t suvs, uint32_t dw, uint32_t dh, uint32_t dys,
                 uint32_t duvs, const char *name) {
  Nv12 src(sw, sh, sys, suvs);
  src.fill([](uint32_t, uint32_t) { return uint8_t{63}; }, [](uint32_t, uint32_t) { return uint8_t{102}; },
           [](uint32_t, uint32_t) { return uint8_t{240}; });
  Nv12 dst(dw, dh, dys, duvs);
  if (!scaleNv12(src.constPlanes(), sw, sh, dst.planes(), dw, dh)) fail(name);
  for (uint32_t row = 0; row < dh; ++row)
    for (uint32_t x = 0; x < dw; ++x)
      if (dst.lumaAt(x, row) != 63) fail(name);
  for (uint32_t cy = 0; cy < nv12ChromaRows(dh); ++cy)
    for (uint32_t cx = 0; cx < nv12ChromaWidth(dw); ++cx)
      if (dst.cbAt(cx, cy) != 102 || dst.crAt(cx, cy) != 240) fail(name);
  if (!dst.paddingUntouched()) fail(name);
}

// A linear ramp is reproduced by bilinear sampling: output x maps to source
// (x + 0.5) * sw / dw - 0.5, clamped at the borders.
void expectRamp(uint32_t sw, uint32_t sh, uint32_t dw, uint32_t dh, const char *name) {
  Nv12 src(sw, sh, sw + 8, 2 * nv12ChromaWidth(sw) + 6);
  const uint32_t scw = nv12ChromaWidth(sw), sch = nv12ChromaRows(sh);
  const auto ramp = [](uint32_t i, uint32_t n) { return n > 1 ? 16.0 + 200.0 * i / (n - 1) : 16.0; };
  src.fill([&](uint32_t x, uint32_t) { return static_cast<uint8_t>(ramp(x, sw) + 0.5); },
           [&](uint32_t cx, uint32_t) { return static_cast<uint8_t>(ramp(cx, scw) + 0.5); },
           [&](uint32_t, uint32_t cy) { return static_cast<uint8_t>(ramp(cy, sch) + 0.5); });
  Nv12 dst(dw, dh, dw + 3, 2 * nv12ChromaWidth(dw) + 5);
  if (!scaleNv12(src.constPlanes(), sw, sh, dst.planes(), dw, dh)) fail(name);
  const auto sourcePos = [](uint32_t d, uint32_t srcSize, uint32_t dstSize) {
    double p = (d + 0.5) * srcSize / dstSize - 0.5;
    if (p < 0) p = 0;
    if (p > srcSize - 1.0) p = srcSize - 1.0;
    return p;
  };
  const uint32_t dcw = nv12ChromaWidth(dw), dch = nv12ChromaRows(dh);
  // Tolerance: source rounding (0.5) + 8-bit weights + output rounding.
  for (uint32_t row = 0; row < dh; ++row) {
    for (uint32_t x = 0; x < dw; ++x) {
      const double want = sw > 1 ? 16.0 + 200.0 * sourcePos(x, sw, dw) / (sw - 1) : 16.0;
      if (absDiff(dst.lumaAt(x, row), static_cast<int>(want + 0.5)) > 2) fail(name);
    }
  }
  for (uint32_t cy = 0; cy < dch; ++cy) {
    for (uint32_t cx = 0; cx < dcw; ++cx) {
      const double wantCb = scw > 1 ? 16.0 + 200.0 * sourcePos(cx, scw, dcw) / (scw - 1) : 16.0;
      const double wantCr = sch > 1 ? 16.0 + 200.0 * sourcePos(cy, sch, dch) / (sch - 1) : 16.0;
      if (absDiff(dst.cbAt(cx, cy), static_cast<int>(wantCb + 0.5)) > 2) fail(name);
      if (absDiff(dst.crAt(cx, cy), static_cast<int>(wantCr + 0.5)) > 2) fail(name);
    }
  }
  if (!dst.paddingUntouched()) fail(name);
}

}  // namespace

int main() {
  // Same size: exact copy of the visible area, padding ignored on both sides.
  {
    Nv12 src(7, 5, 11, 10);
    src.fill([](uint32_t x, uint32_t y) { return static_cast<uint8_t>(x * 30 + y); },
             [](uint32_t cx, uint32_t cy) { return static_cast<uint8_t>(cx * 50 + cy); },
             [](uint32_t cx, uint32_t cy) { return static_cast<uint8_t>(200 - cx * 20 - cy); });
    Nv12 dst(7, 5, 9, 12);
    if (!scaleNv12(src.constPlanes(), 7, 5, dst.planes(), 7, 5)) fail("identity");
    for (uint32_t row = 0; row < 5; ++row)
      for (uint32_t x = 0; x < 7; ++x)
        if (dst.lumaAt(x, row) != src.lumaAt(x, row)) fail("identity luma");
    for (uint32_t cy = 0; cy < 3; ++cy)
      for (uint32_t cx = 0; cx < 4; ++cx)
        if (dst.cbAt(cx, cy) != src.cbAt(cx, cy) || dst.crAt(cx, cy) != src.crAt(cx, cy)) fail("identity chroma");
    if (!dst.paddingUntouched()) fail("identity padding");
  }

  // Exact 2:1 is a 2x2 box average on both planes.
  {
    Nv12 src(8, 4, 8, 8);
    src.fill([](uint32_t x, uint32_t y) { return static_cast<uint8_t>((x * 37 + y * 91) & 0xff); },
             [](uint32_t cx, uint32_t cy) { return static_cast<uint8_t>((cx * 53 + cy * 29) & 0xff); },
             [](uint32_t cx, uint32_t cy) { return static_cast<uint8_t>((cx * 17 + cy * 101) & 0xff); });
    Nv12 dst(4, 2, 4, 4);
    if (!scaleNv12(src.constPlanes(), 8, 4, dst.planes(), 4, 2)) fail("2:1");
    for (uint32_t row = 0; row < 2; ++row) {
      for (uint32_t x = 0; x < 4; ++x) {
        const int want = (src.lumaAt(2 * x, 2 * row) + src.lumaAt(2 * x + 1, 2 * row) + src.lumaAt(2 * x, 2 * row + 1) +
                          src.lumaAt(2 * x + 1, 2 * row + 1) + 2) / 4;
        if (dst.lumaAt(x, row) != want) fail("2:1 luma box average");
      }
    }
    for (uint32_t cx = 0; cx < 2; ++cx) {
      const int wantCb = (src.cbAt(2 * cx, 0) + src.cbAt(2 * cx + 1, 0) + src.cbAt(2 * cx, 1) + src.cbAt(2 * cx + 1, 1) + 2) / 4;
      const int wantCr = (src.crAt(2 * cx, 0) + src.crAt(2 * cx + 1, 0) + src.crAt(2 * cx, 1) + src.crAt(2 * cx + 1, 1) + 2) / 4;
      if (dst.cbAt(cx, 0) != wantCb || dst.crAt(cx, 0) != wantCr) fail("2:1 chroma box average");
    }
  }

  // Cb and Cr stay in their own channel.
  {
    Nv12 src(8, 8, 8, 8);
    src.fill([](uint32_t, uint32_t) { return uint8_t{100}; }, [](uint32_t, uint32_t) { return uint8_t{0}; },
             [](uint32_t, uint32_t) { return uint8_t{255}; });
    Nv12 dst(6, 6, 6, 6);
    if (!scaleNv12(src.constPlanes(), 8, 8, dst.planes(), 6, 6)) fail("channel separation");
    for (uint32_t cy = 0; cy < 3; ++cy)
      for (uint32_t cx = 0; cx < 3; ++cx)
        if (dst.cbAt(cx, cy) != 0 || dst.crAt(cx, cy) != 255) fail("cb/cr mixed");
  }

  // Solid frames: the sizes the helpers use, padded strides, odd sizes, portrait.
  expectSolid(1920, 1080, 1920, 1920, 1280, 720, 1280, 1280, "solid 1080p -> 720p");
  expectSolid(1080, 1920, 1088, 1088, 720, 1280, 736, 736, "solid 1080x1920 -> 720x1280 portrait");
  expectSolid(3840, 2160, 3840, 3840, 1920, 1080, 1920, 1920, "solid 4K -> 1080p");
  expectSolid(1280, 720, 1344, 1300, 1920, 1080, 1984, 1930, "solid 720p -> 1080p upscale");
  expectSolid(7, 5, 13, 11, 3, 3, 5, 7, "solid odd -> odd");
  expectSolid(5, 3, 5, 6, 8, 6, 8, 8, "solid odd -> even upscale");
  expectSolid(1, 1, 1, 2, 4, 4, 4, 4, "solid 1x1 -> 4x4");
  expectSolid(16, 16, 16, 16, 1, 1, 1, 2, "solid 16x16 -> 1x1");

  // Ramps: geometry of the sampling grid.
  expectRamp(1920, 1080, 1280, 720, "ramp 1080p -> 720p");
  expectRamp(1080, 1920, 720, 1280, "ramp 1080x1920 -> 720x1280 portrait");
  expectRamp(1080, 1920, 540, 960, "ramp portrait 2:1");
  expectRamp(64, 36, 96, 54, "ramp upscale 1.5x");
  expectRamp(33, 17, 21, 9, "ramp odd sizes");
  expectRamp(64, 64, 48, 20, "ramp anamorphic");

  // Rejected input leaves the destination untouched.
  {
    Nv12 src(4, 4, 4, 4);
    src.fill([](uint32_t, uint32_t) { return uint8_t{1}; }, [](uint32_t, uint32_t) { return uint8_t{2}; },
             [](uint32_t, uint32_t) { return uint8_t{3}; });
    Nv12 dst(2, 2, 2, 2);
    const Nv12ConstPlanes s = src.constPlanes();
    const Nv12Planes d = dst.planes();
    if (scaleNv12(s, 0, 4, d, 2, 2) || scaleNv12(s, 4, 0, d, 2, 2)) fail("zero source size");
    if (scaleNv12(s, 4, 4, d, 0, 2) || scaleNv12(s, 4, 4, d, 2, 0)) fail("zero target size");
    Nv12ConstPlanes bad = s; bad.y = nullptr;
    if (scaleNv12(bad, 4, 4, d, 2, 2)) fail("null source luma");
    bad = s; bad.uvStride = 3;
    if (scaleNv12(bad, 4, 4, d, 2, 2)) fail("short source chroma stride");
    bad = s; bad.yStride = 3;
    if (scaleNv12(bad, 4, 4, d, 2, 2)) fail("short source luma stride");
    Nv12Planes badDst = d; badDst.uv = nullptr;
    if (scaleNv12(s, 4, 4, badDst, 2, 2)) fail("null target chroma");
    badDst = d; badDst.yStride = 1;
    if (scaleNv12(s, 4, 4, badDst, 2, 2)) fail("short target luma stride");
    badDst = d; badDst.uvStride = 2;
    if (scaleNv12(s, 4, 4, badDst, 3, 2)) fail("odd target width with short chroma stride");
    for (uint8_t v : dst.y) if (v != kGuard) fail("rejected call wrote luma");
    for (uint8_t v : dst.uv) if (v != kGuard) fail("rejected call wrote chroma");
  }

  std::cout << "nv12_scale_test passed" << std::endl;
  return 0;
}
