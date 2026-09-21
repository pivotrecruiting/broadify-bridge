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
// Policy for the CPU execution provider (no DirectML device, or a self-test
// forcing CPU). Keeps the requested intra-op thread count for throughput but
// disables intra-op spinning: ORT's default busy-wait between ops burns whole
// cores in the shared helper process — exactly on the machines weak enough to
// hit the CPU fallback. No mem-pattern / execution-mode / free-dimension
// overrides: those are DirectML requirements, not CPU ones.
OrtSessionOptionsPolicy makeCpuSessionOptionsPolicy(int intraOpThreads);

}  // namespace broadify::meeting
