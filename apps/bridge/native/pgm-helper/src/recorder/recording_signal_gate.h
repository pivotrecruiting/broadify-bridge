#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace broadify::pgm {

/** Per-frame verdict of the recording gate (see RecordingSignalGate::onFrame). */
struct RecordingGateDecision {
  bool encode = false;
  bool forceKeyframe = false;
  bool mismatchStarted = false;
  bool mismatchEnded = false;
};

/**
 * Decides which captured frames reach the recording encoder while a recording
 * runs (ADR-0006). The VideoToolbox session is bound to the geometry the
 * recording started with, so a source that switches resolution or pixel
 * format mid-recording produces a gap instead of a broken file: frames with
 * a different geometry are skipped, the episode is reported once when it
 * starts and once when it ends, and the first matching frame after an episode
 * is encoded with a forced keyframe. A frame-rate-only change is tolerated
 * (the encoder times frames from their PTS) and only reported for the log.
 * Pure; the engine calls it under its mutex.
 */
class RecordingSignalGate {
 public:
  void arm(uint32_t width, uint32_t height, const std::string &pixelFormat, uint32_t fpsNum, uint32_t fpsDen) {
    width_ = width;
    height_ = height;
    pixelFormat_ = pixelFormat;
    fpsNum_ = fpsNum;
    fpsDen_ = fpsDen;
    armed_ = true;
    mismatched_ = false;
  }

  void reset() {
    armed_ = false;
    mismatched_ = false;
  }

  bool armed() const { return armed_; }
  bool mismatched() const { return mismatched_; }

  RecordingGateDecision onFrame(uint32_t width, uint32_t height, const std::string &pixelFormat) {
    RecordingGateDecision decision;
    if (!armed_) {
      return decision;
    }
    const bool matches = width == width_ && height == height_ && pixelFormat == pixelFormat_;
    if (!matches) {
      if (!mismatched_) {
        mismatched_ = true;
        decision.mismatchStarted = true;
      }
      return decision;
    }
    decision.encode = true;
    if (mismatched_) {
      mismatched_ = false;
      decision.mismatchEnded = true;
      decision.forceKeyframe = true;
    }
    return decision;
  }

  /** True once per change of the measured frame rate against the armed one (log only, the recording continues). */
  bool fpsChanged(uint32_t fpsNum, uint32_t fpsDen) {
    if (!armed_ || (fpsNum == fpsNum_ && fpsDen == fpsDen_)) {
      return false;
    }
    fpsNum_ = fpsNum;
    fpsDen_ = fpsDen;
    return true;
  }

  /** The live preview encodes for viewers only; the recording has its own encoder. */
  static bool shouldEncodePreview(size_t viewers, bool configured) { return configured && viewers > 0; }

 private:
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  std::string pixelFormat_;
  uint32_t fpsNum_ = 0;
  uint32_t fpsDen_ = 1;
  bool armed_ = false;
  bool mismatched_ = false;
};

}  // namespace broadify::pgm
