// Shared archive-encode policy (meeting recorder + PGM recorder): bitrate
// from 0.35 bit/px clamped to 2-40 Mbit/s, two-second GOP, and the finalize
// bound that must stay below every recording-stop RPC timeout.
#include "helper_common/recording_encode_policy.h"

#include <cstdint>
#include <iostream>

using broadify::helper::kRecorderBitsPerPixel;
using broadify::helper::kRecorderFinalizeTimeoutMs;
using broadify::helper::kRecorderMaxBitrateBps;
using broadify::helper::kRecorderMinBitrateBps;
using broadify::helper::recorderKeyframeInterval;
using broadify::helper::recorderVideoBitrateBps;

// The bridge gives recording.stop (meeting) and pgm.recording.stop (PGM) 20 s;
// the helper-side finalize bound must leave headroom below it, otherwise the
// bridge reports failure while the helper is still finalizing.
static_assert(kRecorderFinalizeTimeoutMs > 0, "finalize timeout must be positive");
static_assert(kRecorderFinalizeTimeoutMs < 20'000, "finalize timeout must stay below the recording stop RPC timeouts");
static_assert(kRecorderMinBitrateBps < kRecorderMaxBitrateBps, "bitrate clamp must be ordered");

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recording_encode_policy_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  ok &= expect(kRecorderBitsPerPixel > 0.349 && kRecorderBitsPerPixel < 0.351, "policy is 0.35 bit/px");
  ok &= expect(kRecorderMinBitrateBps == 2'000'000ull && kRecorderMaxBitrateBps == 40'000'000ull,
               "clamp is 2-40 Mbit/s");

  const uint64_t bitrate1080 = recorderVideoBitrateBps(1920, 1080, 30);
  ok &= expect(bitrate1080 >= 21'700'000ull && bitrate1080 <= 21'800'000ull, "1080p30 bitrate is about 21.77 Mbit/s");
  ok &= expect(bitrate1080 == 21'772'800ull, "1080p30 bitrate is exactly 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(1920, 1080, 25) == 18'144'000ull, "1080p25 bitrate is 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(1920, 1080, 50) == 36'288'000ull, "1080p50 bitrate is 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(1920, 1080, 60) == 40'000'000ull, "1080p60 bitrate clamps to max");
  ok &= expect(recorderVideoBitrateBps(1280, 720, 30) == 9'676'800ull, "720p30 bitrate is 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(1280, 720, 60) == 19'353'600ull, "720p60 bitrate is 0.35 bpp");
  ok &= expect(recorderVideoBitrateBps(3840, 2160, 30) == 40'000'000ull, "4K30 bitrate clamps to max");
  ok &= expect(recorderVideoBitrateBps(160, 90, 30) == 2'000'000ull, "tiny bitrate clamps to min");
  ok &= expect(recorderVideoBitrateBps(1920, 1080, 0) == bitrate1080, "fps 0 falls back to 30");

  ok &= expect(recorderKeyframeInterval(30) == 60, "keyframe interval is two seconds");
  ok &= expect(recorderKeyframeInterval(60) == 120, "keyframe interval follows the frame rate");
  ok &= expect(recorderKeyframeInterval(0) == 60, "keyframe interval falls back to 30 fps");

  ok &= expect(kRecorderFinalizeTimeoutMs == 15'000, "finalize timeout is 15 s for both helpers");

  if (!ok) {
    return 1;
  }
  std::cout << "recording_encode_policy_test passed" << std::endl;
  return 0;
}
