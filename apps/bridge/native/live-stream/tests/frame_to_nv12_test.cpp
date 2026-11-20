#include "live_stream/frame_to_nv12.h"

#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "frame_to_nv12_test failed: " << m << std::endl; std::exit(1); }

namespace {

const uint8_t kGuard = 0xA5;

struct Target {
  uint32_t width, height, stride;
  std::vector<uint8_t> y, uv;
  Target(uint32_t w, uint32_t h, uint32_t s)
      : width(w), height(h), stride(s), y(static_cast<size_t>(s) * h, kGuard),
        uv(static_cast<size_t>(s) * nv12ChromaRows(h), kGuard) {}
  Nv12Planes planes() { return Nv12Planes{y.data(), stride, uv.data(), stride}; }
  bool solid(uint8_t luma, uint8_t cb, uint8_t cr) const {
    for (uint32_t row = 0; row < height; ++row)
      for (uint32_t x = 0; x < width; ++x)
        if (y[static_cast<size_t>(row) * stride + x] != luma) return false;
    for (uint32_t row = 0; row < nv12ChromaRows(height); ++row)
      for (uint32_t x = 0; x < nv12ChromaWidth(width); ++x)
        if (uv[static_cast<size_t>(row) * stride + 2 * x] != cb || uv[static_cast<size_t>(row) * stride + 2 * x + 1] != cr) return false;
    return true;
  }
  bool paddingUntouched() const {
    for (uint32_t row = 0; row < height; ++row)
      for (uint32_t x = width; x < stride; ++x)
        if (y[static_cast<size_t>(row) * stride + x] != kGuard) return false;
    return true;
  }
};

CapturedFrame nv12Frame(const std::vector<uint8_t> &y, const std::vector<uint8_t> &uv, uint32_t w, uint32_t h, uint32_t stride) {
  CapturedFrame frame;
  frame.planes[0] = {y.data(), stride, h};
  frame.planes[1] = {uv.data(), stride, nv12ChromaRows(h)};
  frame.planeCount = 2;
  frame.width = w;
  frame.height = h;
  frame.pixelFormat = "nv12";
  return frame;
}

CapturedFrame packedFrame(const std::vector<uint8_t> &data, uint32_t w, uint32_t h, uint32_t stride, const char *format) {
  CapturedFrame frame;
  frame.planes[0] = {data.data(), stride, h};
  frame.planeCount = 1;
  frame.width = w;
  frame.height = h;
  frame.pixelFormat = format;
  return frame;
}

void testNv12() {
  // Padded source stride, same size: a plain copy.
  const uint32_t w = 64, h = 36, stride = 80;
  std::vector<uint8_t> y(static_cast<size_t>(stride) * h, 0);
  std::vector<uint8_t> uv(static_cast<size_t>(stride) * (h / 2), 0);
  for (uint32_t row = 0; row < h; ++row)
    for (uint32_t x = 0; x < w; ++x) y[static_cast<size_t>(row) * stride + x] = static_cast<uint8_t>(16 + (x + row) % 200);
  for (uint32_t row = 0; row < h / 2; ++row)
    for (uint32_t x = 0; x < w; ++x) uv[static_cast<size_t>(row) * stride + x] = static_cast<uint8_t>(100 + (x + row) % 50);
  std::vector<uint8_t> scratch;
  Target same(w, h, 72);
  if (!frameToNv12(nv12Frame(y, uv, w, h, stride), same.planes(), w, h, scratch)) fail("nv12 same size rejected");
  for (uint32_t row = 0; row < h; ++row)
    for (uint32_t x = 0; x < w; ++x)
      if (same.y[static_cast<size_t>(row) * 72 + x] != y[static_cast<size_t>(row) * stride + x]) fail("nv12 luma copy");
  for (uint32_t row = 0; row < h / 2; ++row)
    for (uint32_t x = 0; x < w; ++x)
      if (same.uv[static_cast<size_t>(row) * 72 + x] != uv[static_cast<size_t>(row) * stride + x]) fail("nv12 chroma copy");
  if (!same.paddingUntouched()) fail("nv12 copy wrote into the row padding");
  if (!scratch.empty()) fail("nv12 needs no scratch buffer");

  // Solid frame scaled down: still solid.
  std::vector<uint8_t> solidY(static_cast<size_t>(1920) * 1080, 90);
  std::vector<uint8_t> solidUv(static_cast<size_t>(1920) * 540, 0);
  for (size_t i = 0; i < solidUv.size(); i += 2) {
    solidUv[i] = 110;
    solidUv[i + 1] = 140;
  }
  Target scaled(1280, 720, 1280);
  if (!frameToNv12(nv12Frame(solidY, solidUv, 1920, 1080, 1920), scaled.planes(), 1280, 720, scratch)) fail("nv12 scale rejected");
  if (!scaled.solid(90, 110, 140)) fail("nv12 scale changed a solid frame");

  // Missing chroma plane, too few rows.
  CapturedFrame lumaOnly = nv12Frame(y, uv, w, h, stride);
  lumaOnly.planeCount = 1;
  if (frameToNv12(lumaOnly, same.planes(), w, h, scratch)) fail("nv12 without chroma plane accepted");
  CapturedFrame shortPlane = nv12Frame(y, uv, w, h, stride);
  shortPlane.planes[0].rows = h - 1;
  if (frameToNv12(shortPlane, same.planes(), w, h, scratch)) fail("luma plane with too few rows accepted");
  CapturedFrame shortChroma = nv12Frame(y, uv, w, h, stride);
  shortChroma.planes[1].rows = h / 2 - 1;
  if (frameToNv12(shortChroma, same.planes(), w, h, scratch)) fail("chroma plane with too few rows accepted");
}

void testPacked() {
  const uint32_t w = 64, h = 36;
  std::vector<uint8_t> scratch;

  // YUY2 / UYVY: Y 120, Cb 90, Cr 200 pass through.
  std::vector<uint8_t> yuy2(static_cast<size_t>(w) * 2 * h);
  std::vector<uint8_t> uyvy(yuy2.size());
  for (size_t i = 0; i < yuy2.size(); i += 4) {
    yuy2[i] = 120, yuy2[i + 1] = 90, yuy2[i + 2] = 120, yuy2[i + 3] = 200;
    uyvy[i] = 90, uyvy[i + 1] = 120, uyvy[i + 2] = 200, uyvy[i + 3] = 120;
  }
  Target a(w, h, w);
  if (!frameToNv12(packedFrame(yuy2, w, h, w * 2, "yuy2"), a.planes(), w, h, scratch) || !a.solid(120, 90, 200)) fail("yuy2 same size");
  Target b(w, h, w);
  if (!frameToNv12(packedFrame(uyvy, w, h, w * 2, "uyvy"), b.planes(), w, h, scratch) || !b.solid(120, 90, 200)) fail("uyvy same size");
  if (!scratch.empty()) fail("same-size conversion needs no scratch buffer");
  // Size change: through the scratch buffer and the scaler.
  Target half(w / 2, h / 2, w / 2);
  if (!frameToNv12(packedFrame(yuy2, w, h, w * 2, "yuy2"), half.planes(), w / 2, h / 2, scratch) || !half.solid(120, 90, 200)) fail("yuy2 scaled");
  if (scratch.size() < static_cast<size_t>(w) * h * 3 / 2) fail("scratch must hold the source-size NV12 frame");
  const size_t scratchSize = scratch.size();
  Target up(w * 2, h * 2, w * 2);
  if (!frameToNv12(packedFrame(uyvy, w, h, w * 2, "uyvy"), up.planes(), w * 2, h * 2, scratch) || !up.solid(120, 90, 200)) fail("uyvy scaled up");
  if (scratch.size() != scratchSize) fail("scratch must be reused between calls");

  // BGRA / RGBA pure red: BT.709 limited range 63 / 102 / 240, in both byte orders.
  std::vector<uint8_t> bgra(static_cast<size_t>(w) * 4 * h);
  std::vector<uint8_t> rgba(bgra.size());
  for (size_t i = 0; i < bgra.size(); i += 4) {
    bgra[i] = 0, bgra[i + 1] = 0, bgra[i + 2] = 255, bgra[i + 3] = 255;
    rgba[i] = 255, rgba[i + 1] = 0, rgba[i + 2] = 0, rgba[i + 3] = 255;
  }
  Target c(w, h, w);
  if (!frameToNv12(packedFrame(bgra, w, h, w * 4, "bgra"), c.planes(), w, h, scratch) || !c.solid(63, 102, 240)) fail("bgra red");
  Target d(w, h, w);
  if (!frameToNv12(packedFrame(rgba, w, h, w * 4, "rgba"), d.planes(), w, h, scratch) || !d.solid(63, 102, 240)) fail("rgba red");
  // Portrait meeting program scaled to a remote target.
  std::vector<uint8_t> portrait(static_cast<size_t>(1080) * 4 * 1920);
  for (size_t i = 0; i < portrait.size(); i += 4) {
    portrait[i] = 0, portrait[i + 1] = 0, portrait[i + 2] = 255, portrait[i + 3] = 255;
  }
  Target e(404, 720, 404);
  if (!frameToNv12(packedFrame(portrait, 1080, 1920, 1080 * 4, "bgra"), e.planes(), 404, 720, scratch) || !e.solid(63, 102, 240)) fail("bgra portrait scaled");

  // Rejected inputs.
  Target f(w, h, w);
  if (frameToNv12(packedFrame(yuy2, w, h, w * 2, "p010"), f.planes(), w, h, scratch)) fail("unknown format accepted");
  if (frameToNv12(packedFrame(yuy2, w, h, w * 2, ""), f.planes(), w, h, scratch)) fail("empty format accepted");
  if (frameToNv12(packedFrame(yuy2, w, h, w, "yuy2"), f.planes(), w, h, scratch)) fail("stride too small accepted");
  if (frameToNv12(packedFrame(yuy2, w, h, w, "yuy2"), half.planes(), w / 2, h / 2, scratch)) fail("stride too small accepted on the scaled path");
  if (frameToNv12(packedFrame(yuy2, 0, h, w * 2, "yuy2"), f.planes(), w, h, scratch)) fail("zero width accepted");
  if (frameToNv12(packedFrame(yuy2, w, h, w * 2, "yuy2"), f.planes(), 0, h, scratch)) fail("zero target accepted");
  CapturedFrame noPlanes = packedFrame(yuy2, w, h, w * 2, "yuy2");
  noPlanes.planeCount = 0;
  if (frameToNv12(noPlanes, f.planes(), w, h, scratch)) fail("frame without planes accepted");
  CapturedFrame nullPlane = packedFrame(yuy2, w, h, w * 2, "yuy2");
  nullPlane.planes[0].data = nullptr;
  if (frameToNv12(nullPlane, f.planes(), w, h, scratch)) fail("null plane accepted");
  CapturedFrame shortRows = packedFrame(yuy2, w, h, w * 2, "yuy2");
  shortRows.planes[0].rows = h - 1;
  if (frameToNv12(shortRows, f.planes(), w, h, scratch)) fail("packed plane with too few rows accepted");
  Target nullTarget(w, h, w);
  Nv12Planes broken = nullTarget.planes();
  broken.uv = nullptr;
  if (frameToNv12(packedFrame(yuy2, w, h, w * 2, "yuy2"), broken, w, h, scratch)) fail("null target plane accepted");
}

}  // namespace

int main() {
  testNv12();
  testPacked();
  std::cout << "frame_to_nv12_test passed" << std::endl;
  return 0;
}
