#include "keyer/keyer_tuning.h"

#include <iostream>

using broadify::meeting::KeyerTuning;
using broadify::meeting::applyKeyerTuningPatch;
using broadify::meeting::presetKeyerTuning;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "keyer_tuning_test failed: " << what << std::endl;
  }
  return condition;
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

  KeyerTuning effective = balanced;
  applyKeyerTuningPatch(effective, sharp, "webapp");
  ok &= expect(effective.preset == "sharp" && effective.source == "webapp",
               "webapp patch wins and records source");

  if (!ok) {
    return 1;
  }
  std::cout << "keyer_tuning_test passed" << std::endl;
  return 0;
}
