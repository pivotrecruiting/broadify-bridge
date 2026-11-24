#pragma once

#include <cstdint>

namespace broadify::meeting {

// Consumers that cannot use more than 30 frames per second - the virtual
// camera (its extension emits 30 Hz, and Teams/Zoom cap at 30 anyway), the
// WebRTC program stream and the MJPEG preview - get every program frame up to
// 30 fps and every second one above it (ADR-0010): 60 -> 30, 50 -> 25. Always
// an integer step, so the frames they get stay evenly spaced; 50 -> 30 would
// need an uneven 20/40 ms pick that the extension's free-running timer
// resamples once more. The recorder gets every program frame.
//
// The same step is the "half rate" of a source above 30 fps: a camera that
// delivers a 60 fps program's size only at 30 fps (capture format selection).
constexpr uint32_t outputDivisor(double fps) { return fps > 30.0 ? 2u : 1u; }

}  // namespace broadify::meeting
