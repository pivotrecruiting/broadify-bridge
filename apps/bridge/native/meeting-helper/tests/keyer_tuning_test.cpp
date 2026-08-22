#include "keyer/keyer_tuning.h"

#include <cstdlib>
#include <iostream>

using broadify::meeting::KeyerTuning;
using broadify::meeting::KeyerTuningPatch;
using broadify::meeting::applyKeyerTuningPatch;
using broadify::meeting::presetKeyerTuning;
using broadify::meeting::resolveKeyerTuningFromEnv;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "keyer_tuning_test failed: " << what << std::endl;
  }
  return condition;
}

void setTestEnv(const char *name, const char *value) {
#if defined(_WIN32)
  _putenv_s(name, value);
#else
  setenv(name, value, 1);
#endif
}

void unsetTestEnv(const char *name) {
#if defined(_WIN32)
  _putenv_s(name, "");
#else
  unsetenv(name);
#endif
}

}  // namespace

int main() {
  bool ok = true;
  const KeyerTuning balanced = presetKeyerTuning("balanced");
  const KeyerTuning sharp = presetKeyerTuning("sharp");
  const KeyerTuning soft = presetKeyerTuning("soft");
  ok &= expect(balanced.preset == "balanced", "balanced preset name");
  ok &= expect(sharp.featherPx < balanced.featherPx ||
                   sharp.guidedEpsilon < balanced.guidedEpsilon,
               "sharp preset is crisper than balanced");
  ok &= expect(soft.featherPx > balanced.featherPx &&
                   soft.ofdEpsilonFar > balanced.ofdEpsilonFar,
               "soft preset is smoother than balanced");

  ok &= expect(balanced.guidedEpsilon == 5.0e-4,
               "balanced keeps rc.26 guided epsilon default");
  ok &= expect(balanced.coefficientEma == 0.0,
               "balanced keeps D3D11 coefficient EMA off by default");

  unsetTestEnv("BROADIFY_MEETING_KEYER_PRESET");
  unsetTestEnv("BROADIFY_MEETING_GUIDED_RADIUS");
  unsetTestEnv("BROADIFY_MEETING_GUIDED_EPSILON");
  unsetTestEnv("BROADIFY_MEETING_GUIDED_COEFF_EMA");
  KeyerTuning effective = resolveKeyerTuningFromEnv();
  ok &= expect(effective.source == "default" &&
                   effective.guidedRadius == balanced.guidedRadius,
               "default layer applies without env");
  setTestEnv("BROADIFY_MEETING_GUIDED_RADIUS", "9");
  setTestEnv("BROADIFY_MEETING_GUIDED_EPSILON", "0.001");
  effective = resolveKeyerTuningFromEnv();
  ok &= expect(effective.source == "env" &&
                   effective.guidedRadius == 9 &&
                   effective.guidedEpsilon == 0.001,
               "env layer overrides defaults");
  KeyerTuningPatch webPatch;
  webPatch.preset = "sharp";
  applyKeyerTuningPatch(effective, webPatch, "webapp");
  ok &= expect(effective.preset == "sharp" && effective.source == "webapp",
               "webapp patch wins and records source");
  ok &= expect(effective.guidedRadius == sharp.guidedRadius &&
                   effective.guidedEpsilon == sharp.guidedEpsilon,
               "webapp preset overrides env layer");

  KeyerTuning partial = balanced;
  partial.guidedRadius = 7;
  partial.source = "env";
  KeyerTuningPatch partialPatch;
  partialPatch.featherPx = 3u;
  applyKeyerTuningPatch(partial, partialPatch, "webapp");
  ok &= expect(partial.guidedRadius == 7 && partial.featherPx == 3u,
               "partial webapp patch preserves env fields");
  unsetTestEnv("BROADIFY_MEETING_GUIDED_RADIUS");
  unsetTestEnv("BROADIFY_MEETING_GUIDED_EPSILON");

  if (!ok) {
    return 1;
  }
  std::cout << "keyer_tuning_test passed" << std::endl;
  return 0;
}
