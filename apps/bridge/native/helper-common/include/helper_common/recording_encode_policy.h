#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

// Archive-encode policy shared by the native recorders (meeting helper:
// AVAssetWriter / Media Foundation re-encode; PGM helper: dedicated
// VideoToolbox H.264 High session, ADR-0006). Pure stdlib so every helper and
// every test links it without media frameworks.
namespace broadify::helper {

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
