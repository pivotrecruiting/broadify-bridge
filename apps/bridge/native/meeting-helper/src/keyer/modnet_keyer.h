#pragma once

#include "keyer/keyer.h"
#include "keyer/matting_backend.h"
#if defined(_WIN32)
#include "compose/gpu_preprocess.h"
#endif

#include <cstdint>
#include <memory>
#include <set>
#include <string>

namespace broadify::meeting {

struct ModnetKeyerOptions {
  std::string modelsDir;
  bool loadInApply = true;
};

class ModnetKeyer : public MattingKeyer {
 public:
  explicit ModnetKeyer(ModnetKeyerOptions options);
  ~ModnetKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
#if defined(_WIN32)
  KeyerResult applyGpu(const GpuCameraFrame &cameraFrame,
                       const GpuPreprocessSlot &preprocessSlot,
                       GpuFrameSlot frameSlot,
                       const ModnetLetterboxMapping &letterbox,
                       const KeyerSettings &settings) override;
#endif
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

std::set<uint32_t> parseModnetPrebuildTierSizes(const char *raw);

}  // namespace broadify::meeting
