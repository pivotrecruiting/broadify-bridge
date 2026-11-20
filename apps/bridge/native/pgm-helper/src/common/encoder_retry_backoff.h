#pragma once

#include "live_stream/bitrate_ladder.h"

#include <cstdint>

namespace broadify::pgm {

/**
 * Time between two setup attempts of the preview encoder for an unchanged
 * target, once an attempt has failed. A failed setup can succeed later without
 * any change of the signal (another program frees the hardware encoder, a
 * graphics driver comes back), so the engine keeps trying - but not on every
 * frame: an attempt runs under the engine mutex on the capture thread and is
 * not cheap (Windows: one hardware MFT enumeration and one encoder thread per
 * attempt; per frame that is 30-60 of them a second on a PC without a hardware
 * H.264 encoder). Three seconds make the cost negligible and still bring the
 * picture back without anyone selecting the source again.
 */
constexpr uint64_t kEncoderRetryIntervalNs = 3'000'000'000ULL;

/**
 * Paces the setup attempts of the preview encoder after a failure: the target
 * that failed is tried again once per kEncoderRetryIntervalNs, any other target
 * at once. The engine also calls reset() whenever the measured signal changes,
 * so a new signal never waits. While nothing has failed every attempt is due:
 * with a working encoder this class changes nothing. Pure; the engine calls it
 * under its mutex and passes the time.
 */
class EncoderRetryBackoff {
 public:
  /** True when a setup attempt for `target` may run at `nowNs`. */
  bool attemptDue(const live::EncodeTarget &target, uint64_t nowNs) const {
    if (!failed_ || !sameTarget(target)) {
      return true;
    }
    // A clock that ran backwards must not keep the encoder away for good.
    return nowNs < failedAtNs_ || nowNs - failedAtNs_ >= kEncoderRetryIntervalNs;
  }

  /** The setup attempt for `target` failed at `nowNs`. */
  void onFailure(const live::EncodeTarget &target, uint64_t nowNs) {
    failed_ = true;
    width_ = target.width;
    height_ = target.height;
    fpsNum_ = target.fpsNum;
    fpsDen_ = target.fpsDen;
    failedAtNs_ = nowNs;
  }

  /** The encoder is configured, the signal changed or the source is gone: the next attempt runs at once. */
  void reset() { failed_ = false; }

 private:
  // The fields the engine compares to decide whether its encoder already fits the signal.
  bool sameTarget(const live::EncodeTarget &target) const {
    return target.width == width_ && target.height == height_ && target.fpsNum == fpsNum_ && target.fpsDen == fpsDen_;
  }

  bool failed_ = false;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t fpsNum_ = 0;
  uint32_t fpsDen_ = 1;
  uint64_t failedAtNs_ = 0;
};

}  // namespace broadify::pgm
