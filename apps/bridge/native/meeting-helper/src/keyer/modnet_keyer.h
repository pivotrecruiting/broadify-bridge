#pragma once

#include "keyer/keyer.h"
#include "keyer/matting_backend.h"

#include <memory>
#include <string>

namespace broadify::meeting {

struct ModnetKeyerOptions {
  std::string modelsDir;
};

class ModnetKeyer : public MattingKeyer {
 public:
  explicit ModnetKeyer(ModnetKeyerOptions options);
  ~ModnetKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
  KeyerStatus status() const override;
  // Warm-handover entry (see MattingKeyer): builds/warms the session for the
  // mode's input size on the calling thread. Thread-safe against apply() and
  // status() via an internal mutex (the fused pipeline calls it from a
  // background thread while the async worker owns the keyer path).
  bool warmupForPerformanceMode(const std::string &performanceMode) override;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
