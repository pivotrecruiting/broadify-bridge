#include "keyer/ort_session_options_policy.h"

#include <string>

namespace broadify::meeting {

DirectMlQueueType parseDirectMlQueueType(const char *raw) {
  if (raw != nullptr && std::string(raw) == "direct") {
    return DirectMlQueueType::Direct;
  }
  return DirectMlQueueType::Compute;
}

const char *directMlQueueTypeLabel(DirectMlQueueType queueType) {
  switch (queueType) {
    case DirectMlQueueType::Direct:
      return "direct";
    case DirectMlQueueType::Compute:
      return "compute";
  }
  return "compute";
}

OrtSessionOptionsPolicy makeDirectMlSessionOptionsPolicy(uint32_t inputWidth,
                                                         uint32_t inputHeight) {
  OrtSessionOptionsPolicy policy;
  policy.intraOpThreads = 2;
  policy.disableMemPattern = true;
  policy.sequentialExecution = true;
  policy.configEntries.push_back({"session.intra_op.allow_spinning", "0"});
  policy.freeDimensionOverrides.push_back({"batch_size", 1});
  policy.freeDimensionOverrides.push_back({"height", static_cast<int64_t>(inputHeight)});
  policy.freeDimensionOverrides.push_back({"width", static_cast<int64_t>(inputWidth)});
  return policy;
}

}  // namespace broadify::meeting
