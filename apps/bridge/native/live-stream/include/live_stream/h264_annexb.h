#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace broadify::live {

/**
 * Converts an AVCC (length-prefixed) H.264 access unit into Annex B (start
 * codes), optionally prefixing SPS/PPS so every keyframe is self-contained
 * for RTP receivers that join mid-stream. Pure, platform-independent.
 */
struct H264ParameterSets {
  std::vector<uint8_t> sps;
  std::vector<uint8_t> pps;
};

bool avccToAnnexB(const uint8_t *data, size_t size, size_t nalLengthSize, std::vector<uint8_t> &out);

/** Annex B access unit with SPS+PPS prepended (keyframes only by convention). */
void prependParameterSets(const H264ParameterSets &sets, std::vector<uint8_t> &annexB);

/** NAL unit type (5 bits) of the first NAL in an Annex B buffer, or -1. */
int firstNalType(const std::vector<uint8_t> &annexB);

/** True if any NAL in the Annex B buffer is an IDR slice (type 5). */
bool containsIdr(const std::vector<uint8_t> &annexB);

}  // namespace broadify::live
