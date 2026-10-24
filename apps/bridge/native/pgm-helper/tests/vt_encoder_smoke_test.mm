// Headless VideoToolbox check: configure the hardware encoder, feed NV12
// frames, expect Annex B access units with SPS/PPS on the keyframe and a
// forced keyframe on request. Needs no camera; skips (exit 77) without a
// hardware encoder so CI on VMs stays green but local runs on Apple Silicon verify it.
#import <CoreVideo/CoreVideo.h>

#include "encode/video_encoder.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

using namespace broadify::pgm;

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
  std::mutex mutex;
  std::vector<EncodedAccessUnit> units;
  encoder->onAccessUnit = [&](EncodedAccessUnit &&unit) {
    std::lock_guard<std::mutex> lock(mutex);
    units.push_back(std::move(unit));
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
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  encoder->flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CVPixelBufferRelease(buffer);
  std::lock_guard<std::mutex> lock(mutex);
  if (units.size() < 20) fail("too few access units");
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
  std::cout << "vt_encoder_smoke_test passed (" << units.size() << " access units, " << keyframes << " keyframes, backend " << encoder->info().backend << ")" << std::endl;
  return 0;
}
