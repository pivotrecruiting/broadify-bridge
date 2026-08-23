#include "util/pixel_swizzle.h"

#include <cstring>

#if defined(_WIN32) && (defined(_M_X64) || defined(_M_IX86))
#include <intrin.h>
#include <immintrin.h>
#endif

namespace broadify::meeting {
namespace {

#if defined(_WIN32) && (defined(_M_X64) || defined(_M_IX86))
bool cpuHasAvx2() {
  int regs[4] = {};
  __cpuid(regs, 0);
  if (regs[0] < 7) {
    return false;
  }
  __cpuidex(regs, 7, 0);
  return (regs[1] & (1 << 5)) != 0;
}

void swizzleSwap32Sse2(const uint8_t *src, uint8_t *dst, size_t pixelCount,
                       bool forceOpaqueAlpha) {
  const __m128i maskR = _mm_set1_epi32(0x000000ff);
  const __m128i maskG = _mm_set1_epi32(0x0000ff00);
  const __m128i maskB = _mm_set1_epi32(0x00ff0000);
  const __m128i maskA = _mm_set1_epi32(forceOpaqueAlpha ? 0xff000000 : 0xff000000);
  size_t i = 0;
  for (; i + 4 <= pixelCount; i += 4) {
    const __m128i v = _mm_loadu_si128(reinterpret_cast<const __m128i *>(src + i * 4u));
    const __m128i r = _mm_slli_epi32(_mm_and_si128(v, maskR), 16);
    const __m128i g = _mm_and_si128(v, maskG);
    const __m128i b = _mm_srli_epi32(_mm_and_si128(v, maskB), 16);
    const __m128i a = forceOpaqueAlpha ? maskA : _mm_and_si128(v, maskA);
    _mm_storeu_si128(reinterpret_cast<__m128i *>(dst + i * 4u),
                     _mm_or_si128(_mm_or_si128(r, g), _mm_or_si128(b, a)));
  }
  swizzleBgraToRgbaScalar(src + i * 4u, dst + i * 4u, pixelCount - i,
                          forceOpaqueAlpha);
}

void swizzleSwap32Avx2(const uint8_t *src, uint8_t *dst, size_t pixelCount,
                       bool forceOpaqueAlpha) {
#if defined(__AVX2__) || defined(_MSC_VER)
  const __m256i maskR = _mm256_set1_epi32(0x000000ff);
  const __m256i maskG = _mm256_set1_epi32(0x0000ff00);
  const __m256i maskB = _mm256_set1_epi32(0x00ff0000);
  const __m256i maskA = _mm256_set1_epi32(0xff000000);
  size_t i = 0;
  for (; i + 8 <= pixelCount; i += 8) {
    const __m256i v = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(src + i * 4u));
    const __m256i r = _mm256_slli_epi32(_mm256_and_si256(v, maskR), 16);
    const __m256i g = _mm256_and_si256(v, maskG);
    const __m256i b = _mm256_srli_epi32(_mm256_and_si256(v, maskB), 16);
    const __m256i a = forceOpaqueAlpha ? maskA : _mm256_and_si256(v, maskA);
    _mm256_storeu_si256(reinterpret_cast<__m256i *>(dst + i * 4u),
                        _mm256_or_si256(_mm256_or_si256(r, g),
                                        _mm256_or_si256(b, a)));
  }
  swizzleSwap32Sse2(src + i * 4u, dst + i * 4u, pixelCount - i,
                    forceOpaqueAlpha);
#else
  swizzleSwap32Sse2(src, dst, pixelCount, forceOpaqueAlpha);
#endif
}
#endif

void swizzleSwap32(const uint8_t *src, uint8_t *dst, size_t pixelCount,
                   bool forceOpaqueAlpha) {
#if defined(_WIN32) && (defined(_M_X64) || defined(_M_IX86))
  static const bool hasAvx2 = cpuHasAvx2();
  if (hasAvx2) {
    swizzleSwap32Avx2(src, dst, pixelCount, forceOpaqueAlpha);
  } else {
    swizzleSwap32Sse2(src, dst, pixelCount, forceOpaqueAlpha);
  }
#else
  swizzleBgraToRgbaScalar(src, dst, pixelCount, forceOpaqueAlpha);
#endif
}

}  // namespace

void swizzleBgraToRgbaScalar(const uint8_t *bgra,
                             uint8_t *rgba,
                             size_t pixelCount,
                             bool forceOpaqueAlpha) {
  for (size_t pixel = 0u; pixel < pixelCount; ++pixel) {
    const size_t offset = pixel * 4u;
    rgba[offset + 0u] = bgra[offset + 2u];
    rgba[offset + 1u] = bgra[offset + 1u];
    rgba[offset + 2u] = bgra[offset + 0u];
    rgba[offset + 3u] = forceOpaqueAlpha ? 255u : bgra[offset + 3u];
  }
}

void swizzleRgbaToBgraScalar(const uint8_t *rgba, uint8_t *bgra, size_t pixelCount) {
  swizzleBgraToRgbaScalar(rgba, bgra, pixelCount, false);
}

void swizzleBgraToRgba(const uint8_t *scan0,
                       ptrdiff_t pitch,
                       uint32_t width,
                       uint32_t height,
                       std::vector<uint8_t> &destination) {
  destination.resize(static_cast<size_t>(width) * height * 4u);
  for (uint32_t y = 0; y < height; y++) {
    const uint8_t *src = scan0 + static_cast<ptrdiff_t>(y) * pitch;
    uint8_t *dst = destination.data() + static_cast<size_t>(y) * width * 4u;
    swizzleSwap32(src, dst, width, true);
  }
}

void swizzleRgbaToBgra(const uint8_t *rgba, uint8_t *bgra, size_t pixelCount) {
  swizzleSwap32(rgba, bgra, pixelCount, false);
}

}  // namespace broadify::meeting
