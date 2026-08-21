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
  GuidedWorkSize size = selectGuidedWorkSize(1920u, 1080u, 960u);
  ok &= expect(size.width == 960u && size.height == 540u,
               "default 16:9 work size is at least 960x540");
  size = selectGuidedWorkSize(640u, 360u, 960u);
  ok &= expect(size.width == 640u && size.height == 360u,
               "smaller guides are not upscaled");
  size = selectGuidedWorkSize(1440u, 1080u, 960u);
  ok &= expect(size.width == 960u && size.height == 720u,
               "4:3 work size preserves aspect");
  return ok ? 0 : 1;
}
