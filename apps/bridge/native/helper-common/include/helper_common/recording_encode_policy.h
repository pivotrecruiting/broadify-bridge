#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

// Archive-encode policy shared by the native recorders (meeting helper:
// AVAssetWriter / Media Foundation re-encode; PGM helper: dedicated
// VideoToolbox H.264 High session, ADR-0006). Pure stdlib so every helper and
// every test links it without media frameworks.
namespace broadify::helper {

// Archive codecs of the native recorders (ADR-0010). The PGM recorder writes
// H.264 only; the meeting recorder maps the values to the names of
// `MeetingRecordingCodecT` (meeting-helper/src/recorder/recording_codec.h).
enum class RecordingCodec { H264, Hevc, ProRes422Lt, ProRes422, ProRes422Hq };

constexpr double kRecorderBitsPerPixel = 0.35;
constexpr uint64_t kRecorderMinBitrateBps = 2'000'000ull;
constexpr uint64_t kRecorderMaxBitrateBps = 40'000'000ull;

inline uint64_t recorderVideoBitrateBps(uint32_t width, uint32_t height,
                                        uint32_t fps) {
  const uint32_t safeFps = fps > 0 ? fps : 30;
  const auto pixels = static_cast<double>(static_cast<uint64_t>(width) *
                                          static_cast<uint64_t>(height));
  const auto bitrate = static_cast<uint64_t>(
      std::llround(pixels * static_cast<double>(safeFps) *
                   kRecorderBitsPerPixel));
  return std::clamp(bitrate, kRecorderMinBitrateBps,
                    kRecorderMaxBitrateBps);
}

// HEVC share of the H.264 bitrate for the same picture quality. The HEVC
// verification tests measured about half the bitrate at equal subjective
// quality, but for offline encoders with B-frames and long look-ahead. The
// recorder runs a real-time hardware encoder without frame reordering, which
// gives up part of that gain, so the policy stays at 60 % instead of 50 %: a
// recording must never look worse because a smaller codec was chosen.
constexpr double kRecorderHevcBitrateFactor = 0.6;

// Apple ProRes target data rates at 1920x1080 and 29.97 fps (Apple ProRes
// White Paper). ProRes is quality driven: the encoder takes no bitrate, the
// values only tell how much data a recording is expected to produce.
constexpr uint64_t kRecorderProRes422LtBps1080p30 = 102'000'000ull;
constexpr uint64_t kRecorderProRes422Bps1080p30 = 147'000'000ull;
constexpr uint64_t kRecorderProRes422HqBps1080p30 = 220'000'000ull;

// Video data rate a recording of the given codec and format is expected to
// produce. For H.264 and HEVC it is the average bitrate the encoder is
// configured with; H.264 is recorderVideoBitrateBps, unchanged. For ProRes it
// is Apple's target rate, scaled with pixels and frame rate (the published
// table is close to proportional: 85/122/184 Mbit/s at 1080p25).
inline uint64_t recorderVideoDataRateBps(RecordingCodec codec, uint32_t width,
                                         uint32_t height, uint32_t fps) {
  const auto proResRate = [&](uint64_t bps1080p30) {
    const uint32_t safeFps = fps > 0 ? fps : 30;
    const auto pixelRate = static_cast<double>(static_cast<uint64_t>(width) *
                                               static_cast<uint64_t>(height)) *
                           static_cast<double>(safeFps);
    return static_cast<uint64_t>(std::llround(
        static_cast<double>(bps1080p30) * pixelRate / (1920.0 * 1080.0 * 30.0)));
  };
  switch (codec) {
    case RecordingCodec::H264:
      break;
    case RecordingCodec::Hevc:
      return static_cast<uint64_t>(std::llround(
          static_cast<double>(recorderVideoBitrateBps(width, height, fps)) *
          kRecorderHevcBitrateFactor));
    case RecordingCodec::ProRes422Lt:
      return proResRate(kRecorderProRes422LtBps1080p30);
    case RecordingCodec::ProRes422:
      return proResRate(kRecorderProRes422Bps1080p30);
    case RecordingCodec::ProRes422Hq:
      return proResRate(kRecorderProRes422HqBps1080p30);
  }
  return recorderVideoBitrateBps(width, height, fps);
}

// Free disk space a recording needs to start (REC-02): room for this many
// minutes at the expected video data rate, so a start on a nearly full disk
// is refused with "recording_disk_space_low" instead of failing opaquely
// minutes into the recording. Five minutes is long enough to notice the
// warning and finish a take, and scales from under 1 GB (H.264 1080p30) over
// about 8 GB (ProRes 422 HQ 1080p30) to about 16.5 GB (ProRes 422 HQ
// 1080p60). Audio is left out: it stays below 1.2 Mbit/s.
constexpr uint32_t kRecorderMinFreeDiskMinutes = 5;

inline uint64_t recorderMinFreeDiskBytes(RecordingCodec codec, uint32_t width,
                                         uint32_t height, uint32_t fps) {
  return recorderVideoDataRateBps(codec, width, height, fps) / 8ull * 60ull *
         kRecorderMinFreeDiskMinutes;
}

inline uint32_t recorderKeyframeInterval(uint32_t fps) {
  const uint32_t safeFps = fps > 0 ? fps : 30;
  return safeFps * 2u;
}

// Upper bound for the blocking finalize step in stop() of every recorder
// (AVAssetWriter finishWriting on macOS, IMFSinkWriter::Finalize on Windows).
// When it elapses the recorder reports "finalize_timeout" and keeps the
// ".part" sidecar (REC-03) instead of blocking the sequential control thread
// forever. It MUST stay below the bridge's recording-stop RPC timeouts
// (MEETING_HELPER_RPC_TIMEOUTS_MS["recording.stop"] = 20'000 ms in
// apps/bridge/src/services/meeting/meeting-helper-timeouts.ts and
// PGM_HELPER_RPC_TIMEOUTS_MS["pgm.recording.stop"] = 20'000 ms in
// apps/bridge/src/services/pgm/pgm-helper-client.ts): a client timeout does
// not cancel the helper-side work, so a larger helper bound would make the
// bridge report failure while the helper still finalizes.
// scripts/meeting-helper-release-contract.test.cjs and
// scripts/pgm-helper-release-contract.test.cjs guard the values against
// drifting apart.
constexpr int kRecorderFinalizeTimeoutMs = 15'000;

}  // namespace broadify::helper
