#pragma once

#include "keyer/matting_backend.h"

#include <string>

namespace broadify::meeting {

struct SelfieKeyerOptions {
  std::string modelsDir;
};

class SelfieKeyer final : public MattingKeyer {
 public:
  explicit SelfieKeyer(SelfieKeyerOptions options);
  KeyerResult apply(const VideoFrame &input, const KeyerSettings &settings) override;
  KeyerStatus status() const override;

 private:
  SelfieKeyerOptions options_;
};

}  // namespace broadify::meeting
