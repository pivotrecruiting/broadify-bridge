#pragma once

#include <cstdint>
#include <string>

namespace broadify::live {

/** Encoding profile: lan = source-native up to 1080p, remote = 720p30 for TURN paths, auto = lan. */
enum class EncodeProfile { Auto, Lan, Remote };

/** H.264 profile the encoder session is created with. */
enum class H264Profile { Main, High };

struct EncodeTarget {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fpsNum = 0;
  uint32_t fpsDen = 1;
  uint32_t bitrateKbps = 0;
  uint32_t maxBitrateKbps = 0;
  uint32_t gopSeconds = 2;
  std::string profileName;  // "lan" | "remote" | "archive"
  // Encoder options. The defaults are the live-preview behaviour (Main, speed
  // over quality, hard 1 s data-rate limit); the recording target (ADR-0006)
  // flips all three.
  H264Profile h264Profile = H264Profile::Main;
  bool prioritizeSpeed = true;
  bool hardRateLimit = true;
};

EncodeProfile parseEncodeProfile(const std::string &value);
std::string encodeProfileName(EncodeProfile profile);

/**
 * Picks the encode target for a measured source signal. Pure: the numbers are
 * the ladder from the design (1080p60 8/12 Mbps, 1080p30/50 5-6 Mbps,
 * 720p 2.5-4 Mbps, remote 720p30 2.5 Mbps). Sources above 1080p are capped to
 * 1080p (the encoder scales); anything is clamped to a sane minimum.
 */
EncodeTarget selectEncodeTarget(uint32_t srcWidth, uint32_t srcHeight, uint32_t fpsNum, uint32_t fpsDen,
                                EncodeProfile profile);

/**
 * Picks the archive target for the program recording (ADR-0006). Pure:
 * geometry like the LAN ladder (source-native, capped at 1080 lines, source
 * frame rate) independent of the viewer profile, bitrate from the shared
 * recorder policy (0.35 bit/px, 2-40 Mbit/s; maxBitrateKbps = 1.5x average
 * without a hard data-rate limit), 2 s GOP, H.264 High, quality over speed.
 */
EncodeTarget selectRecordingTarget(uint32_t srcWidth, uint32_t srcHeight, uint32_t fpsNum, uint32_t fpsDen);

}  // namespace broadify::live
