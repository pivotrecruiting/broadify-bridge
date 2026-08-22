#include "keyer/keyer_io_binding_policy.h"

namespace broadify::meeting {

KeyerIoBindingDecision decideKeyerIoBinding(bool gpuResidentEnabled,
                                            bool directMlProviderActive,
                                            bool dmlApiAvailable,
                                            bool inputAllocationCreated,
                                            bool outputBindingCreated) {
  if (!gpuResidentEnabled) {
    return KeyerIoBindingDecision{false, false, "disabled"};
  }
  if (!directMlProviderActive) {
    return KeyerIoBindingDecision{false, true, "directml_provider_inactive"};
  }
  if (!dmlApiAvailable) {
    return KeyerIoBindingDecision{false, true, "dml_api_unavailable"};
  }
  if (!inputAllocationCreated) {
    return KeyerIoBindingDecision{false, true, "input_allocation_failed"};
  }
  if (!outputBindingCreated) {
    return KeyerIoBindingDecision{false, true, "output_binding_failed"};
  }
  return KeyerIoBindingDecision{true, false, ""};
}

}  // namespace broadify::meeting
