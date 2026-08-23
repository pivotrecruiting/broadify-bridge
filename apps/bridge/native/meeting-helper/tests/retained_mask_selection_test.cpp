#include "pipeline/retained_mask_selection.h"

#include <cstdlib>
#include <iostream>

using broadify::meeting::shouldUseRetainedMaskWhenFusedSkipped;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

int main() {
  CHECK(shouldUseRetainedMaskWhenFusedSkipped(false, true, true, true, false));
  CHECK(!shouldUseRetainedMaskWhenFusedSkipped(true, true, true, true, false));
  CHECK(!shouldUseRetainedMaskWhenFusedSkipped(false, false, true, true, false));
  CHECK(!shouldUseRetainedMaskWhenFusedSkipped(false, true, false, true, false));
  CHECK(!shouldUseRetainedMaskWhenFusedSkipped(false, true, true, false, false));
  CHECK(!shouldUseRetainedMaskWhenFusedSkipped(false, true, true, true, true));
  std::cout << "retained_mask_selection_test passed\n";
  return 0;
}
