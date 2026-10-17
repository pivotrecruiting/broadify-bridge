#include "pipeline/guided_work_size.h"

#include <cstdlib>
#include <iostream>

using broadify::meeting::GuidedWorkSize;
using broadify::meeting::GovernorTier;
using broadify::meeting::guidedWorkWidth;
using broadify::meeting::guidedWorkWidthCapForTier;
using broadify::meeting::selectGuidedWorkSize;
using broadify::meeting::setGuidedWorkWidthTierCap;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "guided_work_size_test failed: " << what << std::endl;
  }
  return condition;
}

void setMaskWorkWidthEnv(const char *value) {
#if defined(_WIN32)
  if (value == nullptr) {
    _putenv_s("BROADIFY_MEETING_MASK_WORK_WIDTH", "");
  } else {
    _putenv_s("BROADIFY_MEETING_MASK_WORK_WIDTH", value);
  }
#else
  if (value == nullptr) {
    unsetenv("BROADIFY_MEETING_MASK_WORK_WIDTH");
  } else {
    setenv("BROADIFY_MEETING_MASK_WORK_WIDTH", value, 1);
  }
#endif
}

}  // namespace

int main() {
  bool ok = true;
  constexpr uint32_t kDefaultWorkWidth = 512u;
  constexpr uint32_t kExpected16x9Height = 288u;
  constexpr uint32_t kExpected4x3Height = 384u;
  setMaskWorkWidthEnv(nullptr);
  setGuidedWorkWidthTierCap(0u);
  ok &= expect(guidedWorkWidth() == kDefaultWorkWidth,
               "guided work width keeps the legacy default without env or cap");
  ok &= expect(guidedWorkWidthCapForTier(GovernorTier::Full512) == 0u,
               "Full512 leaves the work-width uncapped");
  ok &= expect(guidedWorkWidthCapForTier(GovernorTier::Balanced320) == 640u,
               "Balanced320 maps to a 640 work-width cap");
  ok &= expect(guidedWorkWidthCapForTier(GovernorTier::Performance256) == 512u,
               "Performance256 maps to a 512 work-width cap");
  setGuidedWorkWidthTierCap(640u);
  ok &= expect(guidedWorkWidth() == kDefaultWorkWidth,
               "tier cap cannot raise the default in this PR");
  setGuidedWorkWidthTierCap(256u);
  ok &= expect(guidedWorkWidth() == 256u,
               "tier cap below the default lowers the guided work width");
  setMaskWorkWidthEnv("960");
  ok &= expect(guidedWorkWidth() == 960u,
               "env pin wins over the tier cap");
  setMaskWorkWidthEnv(nullptr);
  setGuidedWorkWidthTierCap(0u);
  GuidedWorkSize size = selectGuidedWorkSize(1920u, 1080u, kDefaultWorkWidth);
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected16x9Height,
               "default 16:9 work size matches platform default");
  size = selectGuidedWorkSize(640u, 360u, kDefaultWorkWidth);
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected16x9Height,
               "default keeps the legacy 512-wide grid");
  size = selectGuidedWorkSize(1440u, 1080u, kDefaultWorkWidth);
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected4x3Height,
               "4:3 work size preserves aspect");
  return ok ? 0 : 1;
}
