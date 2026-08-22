#pragma once

#include <cstdint>
#include <string>

namespace broadify::meeting {

struct KeyerTuning {
  std::string preset = "balanced";
  std::string source = "default";
  uint32_t guidedRadius = 4;
  double guidedEpsilon = 0.002;
  double coefficientEma = 0.5;
  double erodePx = 0.0;
  uint32_t dilatePx = 1;
  uint32_t featherPx = 1;
  uint8_t ofdEpsilonNear = 8;
  uint8_t ofdEpsilonFar = 24;
  bool edgeStabilizationEnabled = false;
  double edgeStabilizationStrength = 0.25;
  bool cadencePinEnabled = true;
  std::string tier = "auto";
};

KeyerTuning presetKeyerTuning(const std::string &preset);
KeyerTuning resolveKeyerTuningFromEnv();
void applyKeyerTuningPatch(KeyerTuning &base,
                           const KeyerTuning &patch,
                           const std::string &source);

}  // namespace broadify::meeting
