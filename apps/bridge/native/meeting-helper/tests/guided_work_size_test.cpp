#include "pipeline/guided_work_size.h"

#include <iostream>

using broadify::meeting::GuidedWorkSize;
using broadify::meeting::selectGuidedWorkSize;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "guided_work_size_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
#if defined(_WIN32)
  constexpr uint32_t kDefaultWorkWidth = 960u;
  constexpr uint32_t kExpected16x9Height = 540u;
  constexpr uint32_t kExpected4x3Height = 720u;
#else
  constexpr uint32_t kDefaultWorkWidth = 512u;
  constexpr uint32_t kExpected16x9Height = 288u;
  constexpr uint32_t kExpected4x3Height = 384u;
#endif
  GuidedWorkSize size = selectGuidedWorkSize(1920u, 1080u, kDefaultWorkWidth);
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected16x9Height,
               "default 16:9 work size matches platform default");
  size = selectGuidedWorkSize(640u, 360u, kDefaultWorkWidth);
#if defined(_WIN32)
  ok &= expect(size.width == 640u && size.height == 360u,
               "smaller guides are not upscaled");
#else
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected16x9Height,
               "non-Windows default keeps the legacy 512-wide grid");
#endif
  size = selectGuidedWorkSize(1440u, 1080u, kDefaultWorkWidth);
  ok &= expect(size.width == kDefaultWorkWidth &&
                   size.height == kExpected4x3Height,
               "4:3 work size preserves aspect");
  return ok ? 0 : 1;
}
