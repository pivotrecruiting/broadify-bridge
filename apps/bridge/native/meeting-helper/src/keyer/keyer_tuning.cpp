#include "keyer/keyer_tuning.h"

#include <algorithm>
#include <cstdlib>

namespace broadify::meeting {
namespace {

const char *env(const char *name) {
  const char *value = std::getenv(name);
  return value != nullptr && value[0] != '\0' ? value : nullptr;
}

double parseDouble(const char *value, double fallback) {
  if (value == nullptr) {
    return fallback;
  }
  char *end = nullptr;
  const double parsed = std::strtod(value, &end);
  return end != value ? parsed : fallback;
}

uint32_t parseU32(const char *value, uint32_t fallback, uint32_t maxValue) {
  if (value == nullptr) {
    return fallback;
  }
  char *end = nullptr;
  const unsigned long parsed = std::strtoul(value, &end, 10);
  if (end == value) {
    return fallback;
  }
  return static_cast<uint32_t>(std::min<unsigned long>(parsed, maxValue));
}

bool parseBool(const char *value, bool fallback) {
  if (value == nullptr) {
    return fallback;
  }
  return value[0] != '0';
}

}  // namespace

KeyerTuning presetKeyerTuning(const std::string &preset) {
  KeyerTuning tuning;
  tuning.preset = preset == "sharp" || preset == "soft" ? preset : "balanced";
  if (tuning.preset == "sharp") {
    tuning.guidedRadius = 3;
    tuning.guidedEpsilon = 0.0012;
    tuning.coefficientEma = 0.35;
    tuning.dilatePx = 0;
    tuning.featherPx = 0;
    tuning.ofdEpsilonNear = 6;
    tuning.ofdEpsilonFar = 20;
    tuning.edgeStabilizationStrength = 0.2;
  } else if (tuning.preset == "soft") {
    tuning.guidedRadius = 6;
    tuning.guidedEpsilon = 0.004;
    tuning.coefficientEma = 0.65;
    tuning.dilatePx = 2;
    tuning.featherPx = 2;
    tuning.ofdEpsilonNear = 10;
    tuning.ofdEpsilonFar = 30;
    tuning.edgeStabilizationStrength = 0.35;
  }
  return tuning;
}

KeyerTuning resolveKeyerTuningFromEnv() {
  const bool hasEnvTuning =
      env("BROADIFY_MEETING_KEYER_PRESET") != nullptr ||
      env("BROADIFY_MEETING_GUIDED_RADIUS") != nullptr ||
      env("BROADIFY_MEETING_GUIDED_EPSILON") != nullptr ||
      env("BROADIFY_MEETING_GUIDED_COEFF_EMA") != nullptr ||
      env("BROADIFY_MEETING_MASK_ERODE_PX") != nullptr ||
      env("BROADIFY_MEETING_MASK_DILATE_PX") != nullptr ||
      env("BROADIFY_MEETING_MASK_FEATHER_PX") != nullptr ||
      env("BROADIFY_MEETING_EDGE_STAB") != nullptr ||
      env("BROADIFY_MEETING_KEYER_TIER") != nullptr;
  KeyerTuning tuning = presetKeyerTuning(
      env("BROADIFY_MEETING_KEYER_PRESET") != nullptr
          ? env("BROADIFY_MEETING_KEYER_PRESET")
          : "balanced");
  tuning.source = hasEnvTuning ? "env" : "default";
  tuning.guidedRadius = parseU32(env("BROADIFY_MEETING_GUIDED_RADIUS"),
                                 tuning.guidedRadius, 16);
  tuning.guidedEpsilon = parseDouble(env("BROADIFY_MEETING_GUIDED_EPSILON"),
                                     tuning.guidedEpsilon);
  tuning.coefficientEma = parseDouble(env("BROADIFY_MEETING_GUIDED_COEFF_EMA"),
                                      tuning.coefficientEma);
  tuning.erodePx = parseDouble(env("BROADIFY_MEETING_MASK_ERODE_PX"),
                               tuning.erodePx);
  tuning.dilatePx = parseU32(env("BROADIFY_MEETING_MASK_DILATE_PX"),
                             tuning.dilatePx, 8);
  tuning.featherPx = parseU32(env("BROADIFY_MEETING_MASK_FEATHER_PX"),
                              tuning.featherPx, 3);
  tuning.edgeStabilizationEnabled =
      parseBool(env("BROADIFY_MEETING_EDGE_STAB"),
                tuning.edgeStabilizationEnabled);
  tuning.tier = env("BROADIFY_MEETING_KEYER_TIER") != nullptr
                    ? env("BROADIFY_MEETING_KEYER_TIER")
                    : tuning.tier;
  return tuning;
}

void applyKeyerTuningPatch(KeyerTuning &base,
                           const KeyerTuningPatch &patch,
                           const std::string &source) {
  if (patch.preset.has_value()) {
    KeyerTuning preset = presetKeyerTuning(*patch.preset);
    preset.source = base.source;
    preset.tier = base.tier;
    base = preset;
  }
  if (patch.guidedRadius.has_value()) {
    base.guidedRadius = *patch.guidedRadius;
  }
  if (patch.guidedEpsilon.has_value()) {
    base.guidedEpsilon = *patch.guidedEpsilon;
  }
  if (patch.coefficientEma.has_value()) {
    base.coefficientEma = *patch.coefficientEma;
  }
  if (patch.erodePx.has_value()) {
    base.erodePx = *patch.erodePx;
  }
  if (patch.dilatePx.has_value()) {
    base.dilatePx = *patch.dilatePx;
  }
  if (patch.featherPx.has_value()) {
    base.featherPx = *patch.featherPx;
  }
  if (patch.ofdEpsilonNear.has_value()) {
    base.ofdEpsilonNear = *patch.ofdEpsilonNear;
  }
  if (patch.ofdEpsilonFar.has_value()) {
    base.ofdEpsilonFar = *patch.ofdEpsilonFar;
  }
  if (patch.edgeStabilizationEnabled.has_value()) {
    base.edgeStabilizationEnabled = *patch.edgeStabilizationEnabled;
  }
  if (patch.edgeStabilizationStrength.has_value()) {
    base.edgeStabilizationStrength = *patch.edgeStabilizationStrength;
  }
  if (patch.cadencePinEnabled.has_value()) {
    base.cadencePinEnabled = *patch.cadencePinEnabled;
  }
  if (patch.tier.has_value() && !patch.tier->empty()) {
    base.tier = *patch.tier;
  }
  base.source = source;
}

}  // namespace broadify::meeting
