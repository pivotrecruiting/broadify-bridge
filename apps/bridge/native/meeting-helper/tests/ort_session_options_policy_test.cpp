#include "keyer/ort_session_options_policy.h"

#include <iostream>
#include <string>

using broadify::meeting::makeDirectMlSessionOptionsPolicy;
using broadify::meeting::DirectMlQueueType;
using broadify::meeting::directMlQueueTypeLabel;
using broadify::meeting::parseDirectMlQueueType;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "ort_session_options_policy_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  const auto policy = makeDirectMlSessionOptionsPolicy(320, 320);
  bool ok = true;
  ok &= expect(policy.intraOpThreads == 2, "intra-op threads = 2");
  ok &= expect(policy.disableMemPattern, "mem pattern disabled");
  ok &= expect(policy.sequentialExecution, "sequential execution");
  ok &= expect(policy.configEntries.size() == 1, "one config entry");
  ok &= expect(policy.configEntries[0].first == "session.intra_op.allow_spinning",
               "allow spinning key");
  ok &= expect(policy.configEntries[0].second == "0", "allow spinning disabled");
  ok &= expect(policy.freeDimensionOverrides.size() == 3, "free dims");
  ok &= expect(policy.freeDimensionOverrides[1].name == "height" &&
                   policy.freeDimensionOverrides[1].value == 320,
               "height override");
  ok &= expect(policy.freeDimensionOverrides[2].name == "width" &&
                   policy.freeDimensionOverrides[2].value == 320,
               "width override");
  ok &= expect(parseDirectMlQueueType(nullptr) == DirectMlQueueType::Compute,
               "DML queue defaults to compute");
  ok &= expect(parseDirectMlQueueType("") == DirectMlQueueType::Compute,
               "empty DML queue defaults to compute");
  ok &= expect(parseDirectMlQueueType("compute") == DirectMlQueueType::Compute,
               "compute DML queue parses");
  ok &= expect(parseDirectMlQueueType("direct") == DirectMlQueueType::Direct,
               "direct DML queue parses");
  ok &= expect(parseDirectMlQueueType("DIRECT") == DirectMlQueueType::Compute,
               "unknown DML queue falls back to compute");
  ok &= expect(std::string(directMlQueueTypeLabel(DirectMlQueueType::Compute)) ==
                   "compute",
               "compute DML queue label");
  ok &= expect(std::string(directMlQueueTypeLabel(DirectMlQueueType::Direct)) ==
                   "direct",
               "direct DML queue label");
  return ok ? 0 : 1;
}
