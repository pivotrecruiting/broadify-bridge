#include "signal/video_signal_tracker.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace broadify::pgm {

VideoSignalTracker::VideoSignalTracker(uint64_t noSignalAfterNs, size_t windowFrames)
    : noSignalAfterNs_(noSignalAfterNs), windowFrames_(std::max<size_t>(windowFrames, 4)) {}

void VideoSignalTracker::snapFps(double fps, uint32_t &num, uint32_t &den) {
  // Broadcast rates first (fractional NTSC family), then integer rates.
  struct Rate { double fps; uint32_t num; uint32_t den; };
  static const Rate RATES[] = {
      {23.976, 24000, 1001}, {24.0, 24, 1}, {25.0, 25, 1}, {29.97, 30000, 1001}, {30.0, 30, 1},
      {50.0, 50, 1},         {59.94, 60000, 1001}, {60.0, 60, 1}, {100.0, 100, 1}, {119.88, 120000, 1001}, {120.0, 120, 1},
  };
  const Rate *best = nullptr;
  double bestDelta = 1e9;
  for (const Rate &rate : RATES) {
    const double delta = std::abs(rate.fps - fps);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = &rate;
    }
  }
  // Within 1.5 % of a known rate: snap; otherwise report the measured integer rate.
  if (best != nullptr && bestDelta <= best->fps * 0.015) {
    num = best->num;
    den = best->den;
    return;
  }
  num = static_cast<uint32_t>(std::lround(fps));
  den = 1;
}

bool VideoSignalTracker::onFrame(uint32_t width, uint32_t height, const std::string &pixelFormat, uint64_t captureNs) {
  bool changed = false;
  if (signal_.noSignal) {
    signal_.noSignal = false;
    changed = true;
    timestamps_.clear();
  }
  if (width != signal_.width || height != signal_.height || pixelFormat != signal_.pixelFormat) {
    signal_.width = width;
    signal_.height = height;
    signal_.pixelFormat = pixelFormat;
    changed = true;
    timestamps_.clear();
  }
  if (captureNs > 0 && (timestamps_.empty() || captureNs > timestamps_.back())) {
    timestamps_.push_back(captureNs);
    while (timestamps_.size() > windowFrames_) {
      timestamps_.pop_front();
    }
  }
  lastFrameNs_ = captureNs;
  if (timestamps_.size() >= 4) {
    std::vector<uint64_t> intervals;
    intervals.reserve(timestamps_.size());
    for (size_t i = 1; i < timestamps_.size(); ++i) {
      intervals.push_back(timestamps_[i] - timestamps_[i - 1]);
    }
    std::nth_element(intervals.begin(), intervals.begin() + intervals.size() / 2, intervals.end());
    const uint64_t median = intervals[intervals.size() / 2];
    if (median > 0) {
      uint32_t num = 0;
      uint32_t den = 1;
      snapFps(1e9 / static_cast<double>(median), num, den);
      if (num != signal_.fpsNum || den != signal_.fpsDen) {
        signal_.fpsNum = num;
        signal_.fpsDen = den;
        changed = true;
      }
    }
  }
  return changed;
}

bool VideoSignalTracker::onTick(uint64_t nowNs) {
  if (signal_.noSignal || lastFrameNs_ == 0 || nowNs < lastFrameNs_) {
    return false;
  }
  if (nowNs - lastFrameNs_ >= noSignalAfterNs_) {
    return markNoSignal();
  }
  return false;
}

bool VideoSignalTracker::markNoSignal() {
  if (signal_.noSignal) {
    return false;
  }
  signal_.noSignal = true;
  signal_.fpsNum = 0;
  signal_.fpsDen = 1;
  timestamps_.clear();
  return true;
}

}  // namespace broadify::pgm
