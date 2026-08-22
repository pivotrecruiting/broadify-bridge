#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

struct OrtFreeDimensionOverride {
  std::string name;
  int64_t value = 0;
};

struct OrtSessionOptionsPolicy {
  int intraOpThreads = 0;
  bool disableMemPattern = false;
  bool sequentialExecution = false;
  std::vector<std::pair<std::string, std::string>> configEntries;
  std::vector<OrtFreeDimensionOverride> freeDimensionOverrides;
};

enum class DirectMlQueueType { Compute, Direct };

DirectMlQueueType parseDirectMlQueueType(const char *raw);
const char *directMlQueueTypeLabel(DirectMlQueueType queueType);
OrtSessionOptionsPolicy makeDirectMlSessionOptionsPolicy(uint32_t inputWidth,
                                                         uint32_t inputHeight);

}  // namespace broadify::meeting
