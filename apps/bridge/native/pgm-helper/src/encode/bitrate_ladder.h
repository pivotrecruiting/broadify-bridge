#pragma once

#include <cstdint>
#include <string>

namespace broadify::pgm {

/** Encoding profile: lan = source-native up to 1080p, remote = 720p30 for TURN paths, auto = lan. */
enum class EncodeProfile { Auto, Lan, Remote };

struct EncodeTarget {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fpsNum = 0;
  uint32_t fpsDen = 1;
  uint32_t bitrateKbps = 0;
  uint32_t maxBitrateKbps = 0;
  uint32_t gopSeconds = 2;
  std::string profileName;  // "lan" | "remote"
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

}  // namespace broadify::pgm
