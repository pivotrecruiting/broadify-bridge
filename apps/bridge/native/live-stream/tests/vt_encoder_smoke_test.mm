// Headless VideoToolbox check: configure the hardware encoder, feed NV12
// frames, expect Annex B access units with SPS/PPS on the keyframe and a
// forced keyframe on request. A second instance with the recording target
// (H.264 High) runs in parallel on the same pixel buffers, as the PGM helper
// does while recording. Needs no camera; skips (exit 77) without a
// hardware encoder so CI on VMs stays green but local runs on Apple Silicon verify it.
#import <CoreVideo/CoreVideo.h>

#include "live_stream/video_encoder.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "vt_encoder_smoke_test failed: " << m << std::endl; std::exit(1); }

int main() {
  auto encoder = createVideoToolboxEncoder();
  EncodeTarget target = selectEncodeTarget(1280, 720, 30, 1, EncodeProfile::Lan);
  std::string code;
  std::string error;
  if (!encoder->configure(target, code, error)) {
    if (code == "encoder_unavailable") {
      std::cout << "vt_encoder_smoke_test skipped: " << error << std::endl;
      return 77;
    }
    fail(error.c_str());
  }
  auto recording = createVideoToolboxEncoder();
  const EncodeTarget recordingTarget = selectRecordingTarget(1280, 720, 30, 1);
  if (!recording->configure(recordingTarget, code, error)) fail(("second (recording) encoder: " + error).c_str());
  std::mutex mutex;
  std::vector<EncodedAccessUnit> units;
  std::vector<EncodedAccessUnit> recordingUnits;
  encoder->onAccessUnit = [&](EncodedAccessUnit &&unit) {
    std::lock_guard<std::mutex> lock(mutex);
    units.push_back(std::move(unit));
  };
  recording->onAccessUnit = [&](EncodedAccessUnit &&unit) {
    std::lock_guard<std::mutex> lock(mutex);
    if (unit.sample != nullptr) {
      CFRelease(unit.sample);
      unit.sample = nullptr;
    }
    recordingUnits.push_back(std::move(unit));
  };
  CVPixelBufferRef buffer = nullptr;
  if (CVPixelBufferCreate(kCFAllocatorDefault, 1280, 720, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nullptr, &buffer) != kCVReturnSuccess) fail("pixel buffer");
  for (int i = 0; i < 30; ++i) {
    CVPixelBufferLockBaseAddress(buffer, 0);
    uint8_t *y = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 0));
    const size_t stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
    for (size_t row = 0; row < 720; ++row) {
      memset(y + row * stride, static_cast<int>((row + i * 8) & 0xff), 1280);
    }
    uint8_t *uv = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 1));
    memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * 360);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    CapturedFrame frame;
    frame.pixelBuffer = buffer;
    frame.width = 1280;
    frame.height = 720;
    frame.pixelFormat = "nv12";
    frame.captureNs = 1'000'000'000ULL + static_cast<uint64_t>(i) * 33'333'333ULL;
    if (i == 20) {
      encoder->requestKeyframe();
    }
    if (!encoder->encode(frame, false)) fail("encode rejected a frame");
    // Forced keyframe on the recording encoder only (gate return after a signal mismatch).
    if (!recording->encode(frame, i == 10)) fail("recording encode rejected a frame");
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  encoder->flush();
  recording->flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CVPixelBufferRelease(buffer);
  std::lock_guard<std::mutex> lock(mutex);
  if (units.size() < 20) fail("too few access units");
  if (recordingUnits.size() < 20) fail("too few recording access units");
  if (!recordingUnits.front().keyframe || firstNalType(recordingUnits.front().annexB) != 7) fail("recording must open on an IDR with SPS");
  if (spsProfileIdc(units.front().annexB) != 77) fail("preview encoder must emit H.264 Main (profile_idc 77)");
  if (spsProfileIdc(recordingUnits.front().annexB) != 100) fail("recording encoder must emit H.264 High (profile_idc 100)");
  size_t recordingKeyframes = 0;
  for (const EncodedAccessUnit &unit : recordingUnits) {
    if (unit.keyframe) {
      ++recordingKeyframes;
    }
  }
  if (recordingKeyframes < 2) fail("forced keyframe on the recording encoder did not produce a second IDR");
  // Independence: the forced keyframe at i == 10 on the recording encoder must not appear on the preview encoder.
  size_t previewKeyframesBeforeRequest = 0;
  for (const EncodedAccessUnit &unit : units) {
    if (unit.keyframe && unit.captureNs > 1'000'000'000ULL && unit.captureNs < 1'000'000'000ULL + 20ULL * 33'333'333ULL) {
      ++previewKeyframesBeforeRequest;
    }
  }
  if (previewKeyframesBeforeRequest != 0) fail("recording keyframe request leaked into the preview encoder");
  if (!units.front().keyframe || !containsIdr(units.front().annexB) || firstNalType(units.front().annexB) != 7) fail("first unit must be an IDR with SPS first");
  size_t keyframes = 0;
  for (const EncodedAccessUnit &unit : units) {
    if (unit.keyframe) {
      ++keyframes;
      if (firstNalType(unit.annexB) != 7) fail("keyframe without parameter sets");
    }
    if (unit.annexB.size() < 8 || unit.annexB[0] != 0 || unit.annexB[3] != 1) fail("not annex b");
  }
  if (keyframes < 2) fail("forced keyframe did not produce a second IDR");
  std::cout << "vt_encoder_smoke_test passed (" << units.size() << " access units, " << keyframes << " keyframes, backend " << encoder->info().backend
            << "; recording " << recordingUnits.size() << " access units, " << recordingKeyframes << " keyframes, High)" << std::endl;
  return 0;
}
