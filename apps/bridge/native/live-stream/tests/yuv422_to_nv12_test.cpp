#include "live_stream/yuv422_to_nv12.h"

#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "yuv422_to_nv12_test failed: " << m << std::endl; std::exit(1); }

namespace {

const uint8_t kGuard = 0xA5;

// Test picture: luma, Cb and Cr are independent functions of the position so a
// swapped component or a wrong row is visible.
uint8_t lumaAt(uint32_t x, uint32_t y) { return static_cast<uint8_t>(16 + (x * 5 + y * 11) % 220); }
uint8_t cbAt(uint32_t cx, uint32_t y) { return static_cast<uint8_t>(20 + (cx * 9 + y * 23) % 200); }
uint8_t crAt(uint32_t cx, uint32_t y) { return static_cast<uint8_t>(230 - (cx * 13 + y * 7) % 200); }

std::vector<uint8_t> makePacked(uint32_t width, uint32_t height, uint32_t stride, Yuv422Order order) {
  std::vector<uint8_t> bytes(static_cast<size_t>(stride) * height, 0xEE);
  const uint32_t pairs = nv12ChromaWidth(width);
  for (uint32_t y = 0; y < height; ++y) {
    uint8_t *row = &bytes[static_cast<size_t>(y) * stride];
    for (uint32_t cx = 0; cx < pairs; ++cx) {
      const uint8_t y0 = lumaAt(2 * cx, y);
      // Odd width: the second luma of the last macropixel is not part of the picture.
      const uint8_t y1 = 2 * cx + 1 < width ? lumaAt(2 * cx + 1, y) : 0xEE;
      uint8_t *p = row + 4 * cx;
      if (order == Yuv422Order::Yuy2) {
        p[0] = y0, p[1] = cbAt(cx, y), p[2] = y1, p[3] = crAt(cx, y);
      } else {
        p[0] = cbAt(cx, y), p[1] = y0, p[2] = crAt(cx, y), p[3] = y1;
      }
    }
  }
  return bytes;
}

void expectConversion(uint32_t width, uint32_t height, uint32_t srcStride, uint32_t yStride, uint32_t uvStride,
                      Yuv422Order order, const char *name) {
  const std::vector<uint8_t> packed = makePacked(width, height, srcStride, order);
  const uint32_t chromaWidth = nv12ChromaWidth(width), chromaRows = nv12ChromaRows(height);
  std::vector<uint8_t> yPlane(static_cast<size_t>(yStride) * height, kGuard);
  std::vector<uint8_t> uvPlane(static_cast<size_t>(uvStride) * chromaRows, kGuard);
  if (!yuv422ToNv12(packed.data(), srcStride, width, height, order, Nv12Planes{yPlane.data(), yStride, uvPlane.data(), uvStride})) fail(name);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < yStride; ++x) {
      const uint8_t expected = x < width ? lumaAt(x, y) : kGuard;
      if (yPlane[static_cast<size_t>(y) * yStride + x] != expected) fail(name);
    }
  }
  for (uint32_t cy = 0; cy < chromaRows; ++cy) {
    const uint32_t y0 = 2 * cy, y1 = 2 * cy + 1 < height ? 2 * cy + 1 : 2 * cy;
    for (uint32_t x = 0; x < uvStride; ++x) {
      uint8_t expected = kGuard;
      if (x < 2 * chromaWidth) {
        const uint32_t cx = x / 2;
        expected = (x & 1u) == 0 ? static_cast<uint8_t>((cbAt(cx, y0) + cbAt(cx, y1) + 1) / 2)
                                 : static_cast<uint8_t>((crAt(cx, y0) + crAt(cx, y1) + 1) / 2);
      }
      if (uvPlane[static_cast<size_t>(cy) * uvStride + x] != expected) fail(name);
    }
  }
}

}  // namespace

int main() {
  // Hand-written 4x2 frames: luma copied, chroma rows averaged (rounded up at .5).
  {
    const uint8_t yuy2[] = {
        10, 100, 20, 200, 30, 110, 40, 210,   // row 0: Y Cb Y Cr | Y Cb Y Cr
        50, 103, 60, 201, 70, 120, 80, 250};  // row 1
    uint8_t y[8] = {}, uv[4] = {};
    if (!yuv422ToNv12(yuy2, 8, 4, 2, Yuv422Order::Yuy2, Nv12Planes{y, 4, uv, 4})) fail("yuy2 4x2");
    const uint8_t wantY[8] = {10, 20, 30, 40, 50, 60, 70, 80};
    const uint8_t wantUv[4] = {102, 201, 115, 230};  // (100+103+1)/2, (200+201+1)/2, (110+120)/2, (210+250)/2
    for (int i = 0; i < 8; ++i) if (y[i] != wantY[i]) fail("yuy2 4x2 luma");
    for (int i = 0; i < 4; ++i) if (uv[i] != wantUv[i]) fail("yuy2 4x2 chroma");

    const uint8_t uyvy[] = {
        100, 10, 200, 20, 110, 30, 210, 40,   // row 0: Cb Y Cr Y | Cb Y Cr Y
        103, 50, 201, 60, 120, 70, 250, 80};  // row 1
    uint8_t y2[8] = {}, uv2[4] = {};
    if (!yuv422ToNv12(uyvy, 8, 4, 2, Yuv422Order::Uyvy, Nv12Planes{y2, 4, uv2, 4})) fail("uyvy 4x2");
    for (int i = 0; i < 8; ++i) if (y2[i] != wantY[i]) fail("uyvy 4x2 luma");
    for (int i = 0; i < 4; ++i) if (uv2[i] != wantUv[i]) fail("uyvy 4x2 chroma");
  }

  // Pure colours stay what they are (no matrix, no range change): limited-range
  // BT.709 red is Y 63 / Cb 102 / Cr 240 before and after.
  {
    std::vector<uint8_t> red(8 * 4 * 2);
    for (size_t i = 0; i < red.size(); i += 4) red[i] = 63, red[i + 1] = 102, red[i + 2] = 63, red[i + 3] = 240;
    std::vector<uint8_t> y(8 * 4), uv(8 * 2);
    if (!yuv422ToNv12(red.data(), 16, 8, 4, Yuv422Order::Yuy2, Nv12Planes{y.data(), 8, uv.data(), 8})) fail("solid red");
    for (uint8_t v : y) if (v != 63) fail("solid red luma");
    for (size_t i = 0; i < uv.size(); i += 2) if (uv[i] != 102 || uv[i + 1] != 240) fail("solid red chroma");
  }

  for (const Yuv422Order order : {Yuv422Order::Yuy2, Yuv422Order::Uyvy}) {
    expectConversion(16, 8, 32, 16, 16, order, "16x8 tight");
    expectConversion(16, 8, 48, 24, 20, order, "16x8 padded strides");
    expectConversion(6, 5, 12, 6, 6, order, "odd height: last chroma row copied");
    expectConversion(7, 4, 16, 7, 8, order, "odd width: last macropixel has one luma");
    expectConversion(7, 5, 19, 9, 11, order, "odd width and height, unaligned strides");
    expectConversion(1, 1, 4, 1, 2, order, "1x1");
    expectConversion(2, 1, 4, 2, 2, order, "2x1");
    expectConversion(1080, 1920, 2160 + 32, 1088, 1088, order, "1080x1920 portrait");
    expectConversion(1920, 1080, 3840, 1920, 1920, order, "1920x1080");
  }

  // Rejected input leaves the destination untouched.
  {
    const std::vector<uint8_t> packed = makePacked(4, 2, 8, Yuv422Order::Yuy2);
    std::vector<uint8_t> y(8, kGuard), uv(4, kGuard);
    const Nv12Planes p{y.data(), 4, uv.data(), 4};
    if (yuv422ToNv12(nullptr, 8, 4, 2, Yuv422Order::Yuy2, p)) fail("null source");
    if (yuv422ToNv12(packed.data(), 8, 0, 2, Yuv422Order::Yuy2, p)) fail("zero width");
    if (yuv422ToNv12(packed.data(), 8, 4, 0, Yuv422Order::Yuy2, p)) fail("zero height");
    if (yuv422ToNv12(packed.data(), 7, 4, 2, Yuv422Order::Yuy2, p)) fail("short source stride");
    // Odd width still needs the whole last macropixel: 3 px -> 8 bytes, not 6.
    if (yuv422ToNv12(packed.data(), 6, 3, 2, Yuv422Order::Yuy2, p)) fail("odd width needs whole macropixels");
    if (yuv422ToNv12(packed.data(), 8, 4, 2, Yuv422Order::Yuy2, Nv12Planes{y.data(), 3, uv.data(), 4})) fail("short luma stride");
    if (yuv422ToNv12(packed.data(), 8, 4, 2, Yuv422Order::Yuy2, Nv12Planes{y.data(), 4, uv.data(), 3})) fail("short chroma stride");
    if (yuv422ToNv12(packed.data(), 8, 4, 2, Yuv422Order::Yuy2, Nv12Planes{nullptr, 4, uv.data(), 4})) fail("null luma plane");
    for (uint8_t v : y) if (v != kGuard) fail("rejected call wrote luma");
    for (uint8_t v : uv) if (v != kGuard) fail("rejected call wrote chroma");
  }

  std::cout << "yuv422_to_nv12_test passed" << std::endl;
  return 0;
}
