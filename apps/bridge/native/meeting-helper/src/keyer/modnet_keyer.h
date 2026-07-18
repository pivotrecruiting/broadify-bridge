#pragma once

#include "keyer/keyer.h"

#include <memory>
#include <string>

namespace broadify::meeting {

struct ModnetKeyerOptions {
  std::string modelsDir;
  bool keyerSelfTest = false;
};

class ModnetKeyer : public Keyer {
 public:
  explicit ModnetKeyer(ModnetKeyerOptions options);
  ~ModnetKeyer() override;

  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
  KeyerStatus status() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
