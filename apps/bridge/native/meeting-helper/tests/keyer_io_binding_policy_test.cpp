#include "keyer/keyer_io_binding_policy.h"

#include <cassert>

using broadify::meeting::decideKeyerIoBinding;

int main() {
  auto disabled = decideKeyerIoBinding(false, false, false, false, false);
  assert(!disabled.useIoBinding);
  assert(!disabled.fallbackToCpuTensor);

  auto noProvider = decideKeyerIoBinding(true, false, true, true, true);
  assert(!noProvider.useIoBinding);
  assert(noProvider.fallbackToCpuTensor);
  assert(noProvider.reason == "directml_provider_inactive");

  auto noApi = decideKeyerIoBinding(true, true, false, true, true);
  assert(noApi.reason == "dml_api_unavailable");

  auto noInput = decideKeyerIoBinding(true, true, true, false, true);
  assert(noInput.reason == "input_allocation_failed");

  auto noOutput = decideKeyerIoBinding(true, true, true, true, false);
  assert(noOutput.reason == "output_binding_failed");

  auto active = decideKeyerIoBinding(true, true, true, true, true);
  assert(active.useIoBinding);
  assert(!active.fallbackToCpuTensor);
  return 0;
}
