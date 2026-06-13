#pragma once

#include "keyer/keyer.h"

#include <memory>

namespace broadify::meeting {

class VisionKeyer final : public Keyer {
 public:
  VisionKeyer();
  ~VisionKeyer() override;

  KeyerResult apply(const VideoFrame &input) override;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace broadify::meeting
