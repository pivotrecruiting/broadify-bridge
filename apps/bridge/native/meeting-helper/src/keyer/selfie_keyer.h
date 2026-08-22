#pragma once

#include "keyer/matting_backend.h"

#include <memory>
#include <string>

namespace broadify::meeting {

struct SelfieKeyerOptions {
  std::string modelsDir;
};

class SelfieKeyer final : public MattingKeyer {
 public:
  explicit SelfieKeyer(SelfieKeyerOptions options);
  ~SelfieKeyer() override;
  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
  KeyerStatus status() const override;

 private:
  class Impl;
  SelfieKeyerOptions options_;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
