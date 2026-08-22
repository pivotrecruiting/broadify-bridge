#pragma once

#include <string>

namespace broadify::meeting {

struct KeyerIoBindingDecision {
  bool useIoBinding = false;
  bool fallbackToCpuTensor = false;
  std::string reason;
};

KeyerIoBindingDecision decideKeyerIoBinding(bool gpuResidentEnabled,
                                            bool directMlProviderActive,
                                            bool dmlApiAvailable,
                                            bool inputAllocationCreated,
                                            bool outputBindingCreated);

}  // namespace broadify::meeting
