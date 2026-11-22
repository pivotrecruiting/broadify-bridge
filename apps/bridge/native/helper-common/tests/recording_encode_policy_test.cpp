// Shared archive-encode policy (meeting recorder + PGM recorder): bitrate
// from 0.35 bit/px clamped to 2-40 Mbit/s, two-second GOP, and the finalize
// bound that must stay below every recording-stop RPC timeout. The per-codec
// data rates and the free-disk floor are the meeting recorder's (ADR-0010);
// the H.264 values above them are what the PGM recording keeps getting.
#include "helper_common/recording_encode_policy.h"

#include <cstdint>
#include <iostream>

using broadify::helper::kRecorderBitsPerPixel;
using broadify::helper::kRecorderFinalizeTimeoutMs;
using broadify::helper::kRecorderMaxBitrateBps;
using broadify::helper::kRecorderMinBitrateBps;
using broadify::helper::kRecorderMinFreeDiskMinutes;
using broadify::helper::RecordingCodec;
using broadify::helper::recorderKeyframeInterval;
using broadify::helper::recorderMinFreeDiskBytes;
using broadify::helper::recorderVideoBitrateBps;
using broadify::helper::recorderVideoDataRateBps;

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

  // H.264 by codec is the function the PGM recording calls, value for value.
  for (const uint32_t fps : {0u, 25u, 30u, 50u, 60u}) {
    ok &= expect(recorderVideoDataRateBps(RecordingCodec::H264, 1920, 1080, fps) ==
                     recorderVideoBitrateBps(1920, 1080, fps),
                 "H.264 data rate equals the shared H.264 bitrate at 1080p");
    ok &= expect(recorderVideoDataRateBps(RecordingCodec::H264, 3840, 2160, fps) ==
                     recorderVideoBitrateBps(3840, 2160, fps),
                 "H.264 data rate equals the shared H.264 bitrate at 4K");
    ok &= expect(recorderVideoDataRateBps(RecordingCodec::H264, 160, 90, fps) ==
                     recorderVideoBitrateBps(160, 90, fps),
                 "H.264 data rate equals the shared H.264 bitrate at the minimum");
  }

  // HEVC: 60 % of the H.264 bitrate, including its clamp.
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 1920, 1080, 30) == 13'063'680ull,
               "HEVC 1080p30 is 60 % of H.264");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 1920, 1080, 25) == 10'886'400ull,
               "HEVC 1080p25 is 60 % of H.264");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 1080, 1920, 30) == 13'063'680ull,
               "HEVC portrait equals landscape");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 3840, 2160, 30) == 24'000'000ull,
               "HEVC follows the H.264 cap (no higher resolution cap here)");

  // ProRes: Apple's target rates at 1080p29.97, scaled with pixels and fps.
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Lt, 1920, 1080, 30) == 102'000'000ull,
               "ProRes 422 LT 1080p30 is 102 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422, 1920, 1080, 30) == 147'000'000ull,
               "ProRes 422 1080p30 is 147 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Hq, 1920, 1080, 30) == 220'000'000ull,
               "ProRes 422 HQ 1080p30 is 220 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Lt, 1920, 1080, 25) == 85'000'000ull,
               "ProRes 422 LT 1080p25 is 85 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422, 1920, 1080, 25) == 122'500'000ull,
               "ProRes 422 1080p25 is about 122 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Hq, 1920, 1080, 25) == 183'333'333ull,
               "ProRes 422 HQ 1080p25 is about 184 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422, 1080, 1920, 30) == 147'000'000ull,
               "ProRes portrait equals landscape");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422, 1920, 1080, 0) == 147'000'000ull,
               "ProRes fps 0 falls back to 30");

  // 50 and 60 fps (meeting program on macOS, ADR-0010). The H.264 cap stays
  // at 40 Mbit/s: 1080p50 is under it, 1080p60 is held to it (the policy
  // value would be 43.5 Mbit/s), and HEVC follows as 60 % of either.
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::H264, 1920, 1080, 50) == 36'288'000ull,
               "H.264 1080p50 is 36.288 Mbit/s, under the cap");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::H264, 1920, 1080, 60) == 40'000'000ull,
               "H.264 1080p60 is held to the 40 Mbit/s cap");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 1920, 1080, 50) == 21'772'800ull,
               "HEVC 1080p50 is 60 % of H.264");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::Hevc, 1920, 1080, 60) == 24'000'000ull,
               "HEVC 1080p60 is 60 % of the capped H.264 rate");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Lt, 1920, 1080, 60) == 204'000'000ull,
               "ProRes 422 LT 1080p60 scales linearly to 204 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422, 1920, 1080, 50) == 245'000'000ull,
               "ProRes 422 1080p50 scales linearly to 245 Mbit/s");
  ok &= expect(recorderVideoDataRateBps(RecordingCodec::ProRes422Hq, 1920, 1080, 60) == 440'000'000ull,
               "ProRes 422 HQ 1080p60 scales linearly to 440 Mbit/s");
  ok &= expect(recorderKeyframeInterval(50) == 100, "keyframe interval is two seconds at 50 fps");

  // Free-disk floor: five minutes at the expected data rate.
  ok &= expect(kRecorderMinFreeDiskMinutes == 5, "free-disk floor is five minutes");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::H264, 1920, 1080, 30) == 816'480'000ull,
               "H.264 1080p30 needs about 0.8 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::Hevc, 1920, 1080, 30) == 489'888'000ull,
               "HEVC 1080p30 needs about 0.5 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::ProRes422Hq, 1920, 1080, 60) == 16'500'000'000ull,
               "ProRes 422 HQ 1080p60 needs 16.5 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::H264, 1920, 1080, 60) == 1'500'000'000ull,
               "H.264 1080p60 needs 1.5 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::ProRes422Lt, 1920, 1080, 30) == 3'825'000'000ull,
               "ProRes 422 LT 1080p30 needs about 3.8 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::ProRes422, 1920, 1080, 30) == 5'512'500'000ull,
               "ProRes 422 1080p30 needs about 5.5 GB");
  ok &= expect(recorderMinFreeDiskBytes(RecordingCodec::ProRes422Hq, 1920, 1080, 30) == 8'250'000'000ull,
               "ProRes 422 HQ 1080p30 needs about 8.3 GB");

  if (!ok) {
    return 1;
  }
  std::cout << "recording_encode_policy_test passed" << std::endl;
  return 0;
}
