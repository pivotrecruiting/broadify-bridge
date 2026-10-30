#include "live_stream/bitrate_ladder.h"

#include "helper_common/recording_encode_policy.h"

#include <algorithm>
#include <cmath>

namespace broadify::live {

EncodeProfile parseEncodeProfile(const std::string &value) {
  if (value == "remote") {
    return EncodeProfile::Remote;
  }
  if (value == "lan") {
    return EncodeProfile::Lan;
  }
  return EncodeProfile::Auto;
}

std::string encodeProfileName(EncodeProfile profile) {
  return profile == EncodeProfile::Remote ? "remote" : "lan";
}

EncodeTarget selectEncodeTarget(uint32_t srcWidth, uint32_t srcHeight, uint32_t fpsNum, uint32_t fpsDen,
                                EncodeProfile profile) {
  EncodeTarget target;
  if (fpsDen == 0) {
    fpsDen = 1;
  }
  const double fps = fpsNum > 0 ? static_cast<double>(fpsNum) / static_cast<double>(fpsDen) : 30.0;
  uint32_t width = std::max<uint32_t>(srcWidth, 16);
  uint32_t height = std::max<uint32_t>(srcHeight, 16);
  if (profile == EncodeProfile::Remote) {
    // Remote viewers go through TURN: 720p30 keeps egress and latency sane.
    if (height > 720) {
      width = static_cast<uint32_t>(static_cast<double>(width) * 720.0 / static_cast<double>(height)) & ~1u;
      height = 720;
    }
    target.width = width;
    target.height = height;
    target.fpsNum = fps > 30.0 ? 30 : (fpsNum > 0 ? fpsNum : 30);
    target.fpsDen = fps > 30.0 ? 1 : fpsDen;
    target.bitrateKbps = 2500;
    target.maxBitrateKbps = 3500;
    target.profileName = "remote";
    return target;
  }
  // LAN / auto: source-native, capped at 1080 lines.
  if (height > 1080) {
    width = static_cast<uint32_t>(static_cast<double>(width) * 1080.0 / static_cast<double>(height)) & ~1u;
    height = 1080;
  }
  target.width = width;
  target.height = height;
  target.fpsNum = fpsNum > 0 ? fpsNum : 30;
  target.fpsDen = fpsDen;
  target.profileName = "lan";
  if (height >= 1080) {
    if (fps > 50.5) {
      target.bitrateKbps = 8000;
      target.maxBitrateKbps = 12000;
    } else if (fps > 30.5) {
      target.bitrateKbps = 6000;
      target.maxBitrateKbps = 9000;
    } else {
      target.bitrateKbps = 5000;
      target.maxBitrateKbps = 7500;
    }
  } else if (height >= 720) {
    target.bitrateKbps = fps > 30.5 ? 4000 : 2500;
    target.maxBitrateKbps = fps > 30.5 ? 6000 : 4000;
  } else {
    target.bitrateKbps = 1500;
    target.maxBitrateKbps = 2500;
  }
  return target;
}

EncodeTarget selectRecordingTarget(uint32_t srcWidth, uint32_t srcHeight, uint32_t fpsNum, uint32_t fpsDen) {
  EncodeTarget target;
  if (fpsDen == 0) {
    fpsDen = 1;
  }
  uint32_t width = std::max<uint32_t>(srcWidth, 16);
  uint32_t height = std::max<uint32_t>(srcHeight, 16);
  // Source-native, capped at 1080 lines (4K capture is out of scope; the encoder scales).
  if (height > 1080) {
    width = static_cast<uint32_t>(static_cast<double>(width) * 1080.0 / static_cast<double>(height)) & ~1u;
    height = 1080;
  }
  target.width = width;
  target.height = height;
  target.fpsNum = fpsNum > 0 ? fpsNum : 30;
  target.fpsDen = fpsNum > 0 ? fpsDen : 1;
  const double fps = static_cast<double>(target.fpsNum) / static_cast<double>(target.fpsDen);
  // The policy works in whole frames per second: 29.97 and 30 share a bitrate.
  const uint32_t policyFps = std::max<uint32_t>(1, static_cast<uint32_t>(std::llround(fps)));
  const uint64_t averageBps = broadify::helper::recorderVideoBitrateBps(width, height, policyFps);
  target.bitrateKbps = static_cast<uint32_t>((averageBps + 500) / 1000);
  target.maxBitrateKbps = static_cast<uint32_t>((averageBps * 3 / 2 + 500) / 1000);
  target.gopSeconds = 2;  // == recorderKeyframeInterval(fps) / fps
  target.profileName = "archive";
  target.h264Profile = H264Profile::High;
  target.prioritizeSpeed = false;
  target.hardRateLimit = false;
  return target;
}

}  // namespace broadify::live
