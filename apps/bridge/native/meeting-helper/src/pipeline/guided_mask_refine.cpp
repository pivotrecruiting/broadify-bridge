#include "pipeline/guided_mask_refine.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <vector>

// Portable "fast guided filter" (He, Sun, Tang 2015) for edge-aware alpha-mask
// refinement. We deliberately do NOT use Core Image's CIGuidedFilter: on the
// tested macOS builds it is a no-op (returns its input unchanged for every
// radius/epsilon), so it silently did nothing. This CPU implementation is small,
// deterministic, dependency-free, and portable to the Windows helper. It snaps a
// soft/blocky segmentation mask onto the real edges of the guide (camera luma),
// which sharpens the boundary and stabilizes it against per-frame jitter.

namespace broadify::meeting {
namespace {

// Guided filter runs at this working width (keeps aspect). The boundary only
// needs enough resolution to sit on the subject's edge; a smaller grid keeps the
// per-frame cost tiny. The caller/compositor upscales the refined mask.
constexpr uint32_t kWorkMaxWidth = 512u;
// Radius (px at working res) must SPAN the mask's edge uncertainty, else the
// filter merely reproduces the input. Epsilon (on 0..1 signals) sets stiffness:
// smaller snaps harder to strong guide edges. Both overridable for field tuning.
constexpr int kGuidedRadiusDefault = 8;
constexpr double kGuidedEpsilonDefault = 1.0e-3;

double envDouble(const char *name, double fallback) {
  const char *raw = std::getenv(name);
  if (raw == nullptr || raw[0] == '\0') return fallback;
  char *end = nullptr;
  const double value = std::strtod(raw, &end);
  if (end == raw || value <= 0.0) return fallback;
  return value;
}

int guidedRadius() {
  static const int r = std::max(
      1, static_cast<int>(envDouble("BROADIFY_MEETING_GUIDED_RADIUS",
                                    kGuidedRadiusDefault) + 0.5));
  return r;
}

float guidedEpsilon() {
  static const float e = static_cast<float>(
      envDouble("BROADIFY_MEETING_GUIDED_EPSILON", kGuidedEpsilonDefault));
  return e;
}

// Bilinear-ish downscale of a planar float image into (dstW x dstH).
std::vector<float> resamplePlane(const std::vector<float> &src, int srcW,
                                 int srcH, int dstW, int dstH) {
  std::vector<float> dst(static_cast<size_t>(dstW) * dstH, 0.0f);
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return dst;
  const float sx = static_cast<float>(srcW) / dstW;
  const float sy = static_cast<float>(srcH) / dstH;
  for (int y = 0; y < dstH; ++y) {
    const float fy = std::min(srcH - 1.0f, (y + 0.5f) * sy - 0.5f);
    const int y0 = std::max(0, static_cast<int>(std::floor(fy)));
    const int y1 = std::min(srcH - 1, y0 + 1);
    const float wy = fy - y0;
    for (int x = 0; x < dstW; ++x) {
      const float fx = std::min(srcW - 1.0f, (x + 0.5f) * sx - 0.5f);
      const int x0 = std::max(0, static_cast<int>(std::floor(fx)));
      const int x1 = std::min(srcW - 1, x0 + 1);
      const float wx = fx - x0;
      const float a = src[(size_t)y0 * srcW + x0];
      const float b = src[(size_t)y0 * srcW + x1];
      const float c = src[(size_t)y1 * srcW + x0];
      const float d = src[(size_t)y1 * srcW + x1];
      dst[(size_t)y * dstW + x] =
          a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) +
          c * (1 - wx) * wy + d * wx * wy;
    }
  }
  return dst;
}

// Separable box blur (radius r) with border-correct averaging (divides by the
// actual in-bounds sample count), via per-line prefix sums. O(W*H).
void boxBlur(std::vector<float> &img, int W, int H, int r) {
  if (r < 1 || W <= 0 || H <= 0) return;
  std::vector<float> tmp(img.size());
  std::vector<double> pre(std::max(W, H) + 1);
  // Horizontal.
  for (int y = 0; y < H; ++y) {
    const float *src = &img[(size_t)y * W];
    float *dst = &tmp[(size_t)y * W];
    pre[0] = 0.0;
    for (int x = 0; x < W; ++x) pre[x + 1] = pre[x] + src[x];
    for (int x = 0; x < W; ++x) {
      const int lo = std::max(0, x - r);
      const int hi = std::min(W - 1, x + r);
      dst[x] = static_cast<float>((pre[hi + 1] - pre[lo]) / (hi - lo + 1));
    }
  }
  // Vertical.
  for (int x = 0; x < W; ++x) {
    pre[0] = 0.0;
    for (int y = 0; y < H; ++y) pre[y + 1] = pre[y] + tmp[(size_t)y * W + x];
    for (int y = 0; y < H; ++y) {
      const int lo = std::max(0, y - r);
      const int hi = std::min(H - 1, y + r);
      img[(size_t)y * W + x] =
          static_cast<float>((pre[hi + 1] - pre[lo]) / (hi - lo + 1));
    }
  }
}

}  // namespace

bool guidedRefineAvailable() { return true; }

void guidedRefineMask(AlphaMask &mask, const VideoFrame &guideFrame) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u ||
      guideFrame.rgba.empty() || guideFrame.width == 0u ||
      guideFrame.height == 0u) {
    return;
  }

  // Working grid from the guide's aspect, capped at kWorkMaxWidth.
  int workW = static_cast<int>(guideFrame.width);
  int workH = static_cast<int>(guideFrame.height);
  if (workW > static_cast<int>(kWorkMaxWidth)) {
    const double scale = static_cast<double>(kWorkMaxWidth) / workW;
    workW = static_cast<int>(kWorkMaxWidth);
    workH = std::max(1, static_cast<int>(guideFrame.height * scale + 0.5));
  }

  // Guide luma (0..1) at full res, then resampled to the working grid.
  const int gW = static_cast<int>(guideFrame.width);
  const int gH = static_cast<int>(guideFrame.height);
  std::vector<float> lumaFull(static_cast<size_t>(gW) * gH);
  for (size_t i = 0, n = lumaFull.size(); i < n; ++i) {
    const uint8_t *px = &guideFrame.rgba[i * 4];
    lumaFull[i] = (0.299f * px[0] + 0.587f * px[1] + 0.114f * px[2]) / 255.0f;
  }
  std::vector<float> I = resamplePlane(lumaFull, gW, gH, workW, workH);

  // Mask (0..1) resampled to the same working grid.
  std::vector<float> maskFull(mask.alpha.size());
  for (size_t i = 0, n = maskFull.size(); i < n; ++i)
    maskFull[i] = mask.alpha[i] / 255.0f;
  std::vector<float> p = resamplePlane(maskFull, static_cast<int>(mask.width),
                                       static_cast<int>(mask.height), workW,
                                       workH);

  const int r = guidedRadius();
  const float eps = guidedEpsilon();
  const size_t n = static_cast<size_t>(workW) * workH;

  std::vector<float> meanI = I, meanP = p;
  boxBlur(meanI, workW, workH, r);
  boxBlur(meanP, workW, workH, r);

  std::vector<float> corrI(n), corrIp(n);
  for (size_t i = 0; i < n; ++i) {
    corrI[i] = I[i] * I[i];
    corrIp[i] = I[i] * p[i];
  }
  boxBlur(corrI, workW, workH, r);
  boxBlur(corrIp, workW, workH, r);

  std::vector<float> a(n), b(n);
  for (size_t i = 0; i < n; ++i) {
    const float varI = corrI[i] - meanI[i] * meanI[i];
    const float covIp = corrIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  boxBlur(a, workW, workH, r);
  boxBlur(b, workW, workH, r);

  std::vector<uint8_t> refined(n);
  for (size_t i = 0; i < n; ++i) {
    const float q = a[i] * I[i] + b[i];
    refined[i] = static_cast<uint8_t>(
        std::clamp(q, 0.0f, 1.0f) * 255.0f + 0.5f);
  }

  mask.width = static_cast<uint32_t>(workW);
  mask.height = static_cast<uint32_t>(workH);
  mask.alpha = std::move(refined);
}

}  // namespace broadify::meeting
