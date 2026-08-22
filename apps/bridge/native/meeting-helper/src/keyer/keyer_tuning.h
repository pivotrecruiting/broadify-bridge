#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace broadify::meeting {

struct KeyerTuning {
  std::string preset = "balanced";
  std::string source = "default";
  uint32_t guidedRadius = 4;
  double guidedEpsilon = 5.0e-4;
  double coefficientEma = 0.0;
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

struct KeyerTuningPatch {
  std::optional<std::string> preset;
  std::optional<uint32_t> guidedRadius;
  std::optional<double> guidedEpsilon;
  std::optional<double> coefficientEma;
  std::optional<double> erodePx;
  std::optional<uint32_t> dilatePx;
  std::optional<uint32_t> featherPx;
  std::optional<uint8_t> ofdEpsilonNear;
  std::optional<uint8_t> ofdEpsilonFar;
  std::optional<bool> edgeStabilizationEnabled;
  std::optional<double> edgeStabilizationStrength;
  std::optional<bool> cadencePinEnabled;
  std::optional<std::string> tier;
};

KeyerTuning presetKeyerTuning(const std::string &preset);
KeyerTuning resolveKeyerTuningFromEnv();
void applyKeyerTuningPatch(KeyerTuning &base,
                           const KeyerTuningPatch &patch,
                           const std::string &source);

}  // namespace broadify::meeting
