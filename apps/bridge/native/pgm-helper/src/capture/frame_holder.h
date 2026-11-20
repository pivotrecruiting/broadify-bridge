#pragma once

#include <memory>

#include "common/live_types.h"

namespace broadify::pgm {

/**
 * A captured frame kept alive beyond the capture callback (snapshots). The
 * platform implementation retains whatever backs the frame (macOS: the
 * CVPixelBuffer) and releases it with the last reference.
 */
class RetainedFrame {
 public:
  virtual ~RetainedFrame() = default;
  /** The frame as delivered, valid for the lifetime of this object. */
  virtual const CapturedFrame &frame() const = 0;
};

/** Retains `frame`; nullptr when it carries nothing that can be kept. Called on the capture thread. */
std::shared_ptr<const RetainedFrame> retainFrame(const CapturedFrame &frame);

}  // namespace broadify::pgm
