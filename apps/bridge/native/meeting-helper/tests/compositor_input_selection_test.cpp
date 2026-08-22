#include "pipeline/compositor_input_selection.h"

#include <iostream>

using broadify::meeting::GovernorOffCompositorInput;
using broadify::meeting::selectGovernorOffCompositorInput;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "compositor_input_selection_test failed: " << what
              << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(selectGovernorOffCompositorInput(true) ==
                   GovernorOffCompositorInput::LastMask,
               "governor Off holds the last good mask");
  ok &= expect(selectGovernorOffCompositorInput(false) ==
                   GovernorOffCompositorInput::BackgroundOnly,
               "governor Off uses background-only when no mask exists");
  return ok ? 0 : 1;
}
