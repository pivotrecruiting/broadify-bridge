#include "pipeline/guided_mask_refine.h"

#include "pipeline/guided_work_size.h"

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
// Radius (px at working res) must SPAN the mask's edge uncertainty, else the
// filter merely reproduces the input. Epsilon (on 0..1 signals) sets stiffness:
// smaller snaps harder to strong guide edges. Both overridable for field tuning.
#if defined(_WIN32)
constexpr int kGuidedRadiusDefault = 4;
constexpr double kGuidedEpsilonDefault = 5.0e-4;
#else
constexpr int kGuidedRadiusDefault = 8;
constexpr double kGuidedEpsilonDefault = 1.0e-3;
#endif

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

// Reusable per-thread scratch. guidedRefineMask runs once per frame on a single
// pipeline thread; holding its working buffers here lets them grow to the
// working-grid size once and be reused for every subsequent frame instead of
// heap-allocating roughly two dozen vectors per invocation. thread_local keeps
// it correct even if the filter is ever driven from more than one thread (each
// gets its own set). Buffers are resized (never shrunk) and fully overwritten
// each frame, so no stale data leaks between frames.
struct GuidedScratch {
  std::vector<float> lumaFull;
  std::vector<float> maskFull;
  std::vector<float> I;
  std::vector<float> p;
  std::vector<float> meanI;
  std::vector<float> meanP;
  std::vector<float> corrI;
  std::vector<float> corrIp;
  std::vector<float> a;
  std::vector<float> b;
  std::vector<float> blurTmp;
  std::vector<double> blurPre;
  std::vector<uint8_t> refined;
};

// Bilinear-ish downscale of a planar float image into dst (sized dstW x dstH).
// Writes every output pixel on the valid path, so dst needs no pre-clear there.
void resamplePlaneInto(std::vector<float> &dst, const std::vector<float> &src,
                       int srcW, int srcH, int dstW, int dstH) {
  dst.resize(static_cast<size_t>(std::max(0, dstW)) * std::max(0, dstH));
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    std::fill(dst.begin(), dst.end(), 0.0f);
    return;
  }
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
}

// Separable box blur (radius r) with border-correct averaging (divides by the
// actual in-bounds sample count), via per-line prefix sums. O(W*H). tmp and pre
// are caller-owned scratch (grown as needed) so the hot path allocates nothing.
void boxBlur(std::vector<float> &img, int W, int H, int r,
             std::vector<float> &tmp, std::vector<double> &pre) {
  if (r < 1 || W <= 0 || H <= 0) return;
  tmp.resize(img.size());
  pre.resize(static_cast<size_t>(std::max(W, H)) + 1);
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

  static thread_local GuidedScratch s;

  const GuidedWorkSize workSize = selectGuidedWorkSize(
      guideFrame.width, guideFrame.height, guidedWorkWidthFromEnv());
  const int workW = static_cast<int>(workSize.width);
  const int workH = static_cast<int>(workSize.height);

  // Guide luma (0..1) at full res, then resampled to the working grid.
  const int gW = static_cast<int>(guideFrame.width);
  const int gH = static_cast<int>(guideFrame.height);
  s.lumaFull.resize(static_cast<size_t>(gW) * gH);
  for (size_t i = 0, count = s.lumaFull.size(); i < count; ++i) {
    const uint8_t *px = &guideFrame.rgba[i * 4];
    s.lumaFull[i] = (0.299f * px[0] + 0.587f * px[1] + 0.114f * px[2]) / 255.0f;
  }
  resamplePlaneInto(s.I, s.lumaFull, gW, gH, workW, workH);

  // Mask (0..1) resampled to the same working grid.
  s.maskFull.resize(mask.alpha.size());
  for (size_t i = 0, count = s.maskFull.size(); i < count; ++i)
    s.maskFull[i] = mask.alpha[i] / 255.0f;
  resamplePlaneInto(s.p, s.maskFull, static_cast<int>(mask.width),
                    static_cast<int>(mask.height), workW, workH);

  const int r = guidedRadius();
  const float eps = guidedEpsilon();
  const size_t n = static_cast<size_t>(workW) * workH;

  s.meanI.assign(s.I.begin(), s.I.end());
  s.meanP.assign(s.p.begin(), s.p.end());
  boxBlur(s.meanI, workW, workH, r, s.blurTmp, s.blurPre);
  boxBlur(s.meanP, workW, workH, r, s.blurTmp, s.blurPre);

  s.corrI.resize(n);
  s.corrIp.resize(n);
  for (size_t i = 0; i < n; ++i) {
    s.corrI[i] = s.I[i] * s.I[i];
    s.corrIp[i] = s.I[i] * s.p[i];
  }
  boxBlur(s.corrI, workW, workH, r, s.blurTmp, s.blurPre);
  boxBlur(s.corrIp, workW, workH, r, s.blurTmp, s.blurPre);

  s.a.resize(n);
  s.b.resize(n);
  for (size_t i = 0; i < n; ++i) {
    const float varI = s.corrI[i] - s.meanI[i] * s.meanI[i];
    const float covIp = s.corrIp[i] - s.meanI[i] * s.meanP[i];
    s.a[i] = covIp / (varI + eps);
    s.b[i] = s.meanP[i] - s.a[i] * s.meanI[i];
  }
  boxBlur(s.a, workW, workH, r, s.blurTmp, s.blurPre);
  boxBlur(s.b, workW, workH, r, s.blurTmp, s.blurPre);

  s.refined.resize(n);
  for (size_t i = 0; i < n; ++i) {
    const float q = s.a[i] * s.I[i] + s.b[i];
    s.refined[i] = static_cast<uint8_t>(
        std::clamp(q, 0.0f, 1.0f) * 255.0f + 0.5f);
  }

  mask.width = static_cast<uint32_t>(workW);
  mask.height = static_cast<uint32_t>(workH);
  mask.alpha.assign(s.refined.begin(), s.refined.end());
}

}  // namespace broadify::meeting
