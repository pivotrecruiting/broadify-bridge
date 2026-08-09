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

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
