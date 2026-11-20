// Headless Media Foundation check, the Windows counterpart of
// vt_encoder_smoke_test: configure the hardware encoder through the
// production factory, feed 60 synthetic NV12 frames, expect Annex B access
// units with SPS/PPS on the keyframes and a forced keyframe on request.
// Needs no camera; skips (exit 77) without a hardware encoder MFT, so CI on
// GPU-less runners stays green while a run on a real machine verifies it.
#include "live_stream/video_encoder.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::live;

static void fail(const std::string &m) {
  std::cerr << "mf_encoder_smoke_test failed: " << m << std::endl;
  std::exit(1);
}

namespace {

constexpr uint32_t kWidth = 1280;
constexpr uint32_t kHeight = 720;
constexpr int kFrames = 60;
constexpr uint64_t kBaseNs = 1'000'000'000ull;
constexpr uint64_t kFrameNs = 33'333'333ull;

struct Collected {
  std::mutex mutex;
  std::vector<EncodedAccessUnit> units;
};

// Feeds kFrames moving-gradient frames at the target rate and returns what came out.
void run(VideoEncoder &encoder, Collected &collected, int keyframeRequestAt) {
  encoder.onAccessUnit = [&collected](EncodedAccessUnit &&unit) {
    std::lock_guard<std::mutex> lock(collected.mutex);
    collected.units.push_back(std::move(unit));
  };
  std::vector<uint8_t> y(static_cast<size_t>(kWidth) * kHeight);
  std::vector<uint8_t> uv(static_cast<size_t>(kWidth) * (kHeight / 2), 128);
  for (int i = 0; i < kFrames; ++i) {
    for (uint32_t row = 0; row < kHeight; ++row) {
      std::fill(y.begin() + static_cast<std::ptrdiff_t>(row) * kWidth,
                y.begin() + static_cast<std::ptrdiff_t>(row + 1) * kWidth,
                static_cast<uint8_t>(16 + ((row + static_cast<uint32_t>(i) * 8) % 220)));
    }
    CapturedFrame frame;
    frame.planes[0] = {y.data(), kWidth, kHeight};
    frame.planes[1] = {uv.data(), kWidth, kHeight / 2};
    frame.planeCount = 2;
    frame.width = kWidth;
    frame.height = kHeight;
    frame.pixelFormat = "nv12";
    frame.captureNs = kBaseNs + static_cast<uint64_t>(i) * kFrameNs;
    if (i == keyframeRequestAt) {
      encoder.requestKeyframe();
    }
    if (!encoder.encode(frame, false)) fail("encode rejected frame " + std::to_string(i));
    std::this_thread::sleep_for(std::chrono::milliseconds(33));
  }
  encoder.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
}

}  // namespace

int main() {
  auto encoder = createHardwareEncoder();
  if (!encoder) fail("createHardwareEncoder returned no encoder");
  if (encoder->info().backend != "mediafoundation") fail("hardware factory backend");
  const EncodeTarget target = selectEncodeTarget(kWidth, kHeight, 30, 1, EncodeProfile::Lan);
  std::string code;
  std::string error;
  if (!encoder->configure(target, code, error)) {
    if (code == "encoder_unavailable") {
      std::cout << "mf_encoder_smoke_test skipped: " << error << std::endl;
      return 77;
    }
    fail(code + ": " + error);
  }
  const EncoderInfo info = encoder->info();
  if (!info.hardware || info.name.empty()) fail("a configured encoder must report a hardware MFT by name");
  std::cout << "mf_encoder_smoke_test encoder: " << info.name << " (" << info.vendorId << ") settings " << info.settings << std::endl;
  const bool canForce = info.settings.find("\"force_keyframe\":true") != std::string::npos;

  Collected collected;
  run(*encoder, collected, 40);
  encoder.reset();

  std::lock_guard<std::mutex> lock(collected.mutex);
  const std::vector<EncodedAccessUnit> &units = collected.units;
  // Paced at the target rate: a hardware encoder must keep up with most frames.
  if (units.size() < 40) fail("too few access units: " + std::to_string(units.size()));
  if (!units.front().keyframe || !containsIdr(units.front().annexB) || firstNalType(units.front().annexB) == -1) fail("first unit must be an IDR");
  if (spsProfileIdc(units.front().annexB) != 77) fail("preview encoder must emit H.264 Main (profile_idc 77), got " + std::to_string(spsProfileIdc(units.front().annexB)));
  size_t keyframes = 0;
  size_t keyframesAfterRequest = 0;
  uint64_t previousNs = 0;
  for (const EncodedAccessUnit &unit : units) {
    if (unit.annexB.size() < 5 || firstNalType(unit.annexB) < 0) fail("not annex b");
    if (unit.captureNs < kBaseNs || (unit.captureNs - kBaseNs) % kFrameNs != 0) fail("capture timestamp is not one of the submitted frames");
    if (unit.captureNs <= previousNs) fail("capture timestamps must increase (no frame reordering)");
    previousNs = unit.captureNs;
    if (unit.keyframe) {
      ++keyframes;
      if (!containsNalType(unit.annexB, 7) || !containsNalType(unit.annexB, 8)) fail("keyframe without parameter sets");
      if (unit.captureNs >= kBaseNs + 40 * kFrameNs && unit.captureNs <= kBaseNs + 45 * kFrameNs) {
        ++keyframesAfterRequest;
      }
    }
  }
  // 60 frames at a 2 s GOP: without the request there would be exactly one keyframe.
  if (canForce && keyframesAfterRequest == 0) fail("requestKeyframe did not produce an IDR");
  if (!canForce && keyframes < 2) fail("without forced keyframes the 1 s GOP must produce a second IDR");

  // The recording target (H.264 High, no hard cap) on the same hardware; reported, since
  // drivers differ in what they offer and the device session records the matrix.
  auto recording = createHardwareEncoder();
  const EncodeTarget recordingTarget = selectRecordingTarget(kWidth, kHeight, 30, 1);
  int recordingProfile = -1;
  size_t recordingUnits = 0;
  std::string recordingSettings;
  if (recording->configure(recordingTarget, code, error)) {
    recordingSettings = recording->info().settings;
    Collected recorded;
    run(*recording, recorded, -1);
    recording.reset();
    std::lock_guard<std::mutex> recordedLock(recorded.mutex);
    recordingUnits = recorded.units.size();
    if (!recorded.units.empty()) {
      recordingProfile = spsProfileIdc(recorded.units.front().annexB);
    }
  } else {
    std::cout << "mf_encoder_smoke_test recording target not configurable: " << error << std::endl;
  }

  std::cout << "mf_encoder_smoke_test passed (" << units.size() << " access units, " << keyframes << " keyframes, encoder " << info.name
            << "; recording target " << recordingUnits << " access units, profile_idc " << recordingProfile << ", settings "
            << recordingSettings << ")" << std::endl;
  return 0;
}
