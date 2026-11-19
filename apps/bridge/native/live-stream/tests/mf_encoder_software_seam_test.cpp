// Media Foundation wiring against a real codec on machines without a GPU:
// Microsoft's software H.264 encoder MFT, wrapped into the asynchronous test
// MFT and injected through the encoder's test seam. This is the only place
// that software encoder is allowed (ADR-0009): it exists in this test binary,
// never in a helper. Skips (exit 77) where the encoder MFT is not installed.
#include <windows.h>

#include <initguid.h>
#include <cguid.h>

#include "mf_encoder_internal.h"
#include "mf_fake_async_mft.h"

#include "live_stream/h264_annexb.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::live;
using broadify::live::test::FakeAsyncEncoderMft;
using broadify::live::test::FakeMftOptions;
using Microsoft::WRL::ComPtr;

static void fail(const std::string &m) {
  std::cerr << "mf_encoder_software_seam_test failed: " << m << std::endl;
  std::exit(1);
}

// CLSID_CMSH264EncoderMFT (wmcodecdsp.h), spelled out so the test needs neither that header nor its uuid library.
static const GUID kMicrosoftH264EncoderMft = {0x6ca50344, 0x051a, 0x4ded, {0x97, 0x79, 0xa4, 0x33, 0x05, 0x16, 0x5e, 0x35}};

// Everything that holds a COM reference lives in here, so the last reference to
// the software MFT is released before main() calls MFShutdown and
// CoUninitialize. CoUninitialize unloads the codec DLL; a ComPtr released
// after it calls into unmapped code (seen as an access violation at exit on
// the first Windows CI run).
static int run() {
  ComPtr<IMFTransform> software;
  const HRESULT created = CoCreateInstance(kMicrosoftH264EncoderMft, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&software));
  if (FAILED(created) || !software) {
    std::cout << "mf_encoder_software_seam_test skipped: Microsoft H.264 encoder MFT not available (hr=0x" << std::hex
              << static_cast<uint32_t>(created) << ")" << std::endl;
    return 77;
  }

  FakeMftOptions options;
  options.inner = software;
  ComPtr<FakeAsyncEncoderMft> wrapped;
  wrapped.Attach(new FakeAsyncEncoderMft(options));
  MfEncoderCandidate candidate;
  candidate.name = "Microsoft H264 Encoder MFT (test seam)";
  candidate.hardware = false;
  candidate.activate = [wrapped](IMFTransform **transform) {
    *transform = static_cast<IMFTransform *>(wrapped.Get());
    (*transform)->AddRef();
    return S_OK;
  };
  auto encoder = createMediaFoundationEncoder(
      [candidate](std::vector<MfEncoderCandidate> &out) {
        out.push_back(candidate);
        return S_OK;
      },
      "");

  constexpr uint32_t kWidth = 640;
  constexpr uint32_t kHeight = 360;
  constexpr int kFrames = 45;
  constexpr uint64_t kBaseNs = 2'000'000'011ull;
  constexpr uint64_t kFrameNs = 33'333'333ull;
  const EncodeTarget target = selectEncodeTarget(kWidth, kHeight, 30, 1, EncodeProfile::Lan);
  std::string code;
  std::string error;
  if (!encoder->configure(target, code, error)) fail("configure: " + code + ": " + error);
  const EncoderInfo info = encoder->info();
  if (info.backend != "mediafoundation" || info.hardware) fail("the seam encoder must not be reported as hardware");
  std::cout << "mf_encoder_software_seam_test settings " << info.settings << std::endl;
  const bool canForce = info.settings.find("\"force_keyframe\":true") != std::string::npos;

  std::mutex mutex;
  std::vector<EncodedAccessUnit> units;
  encoder->onAccessUnit = [&](EncodedAccessUnit &&unit) {
    std::lock_guard<std::mutex> lock(mutex);
    units.push_back(std::move(unit));
  };
  const auto unitCount = [&] {
    std::lock_guard<std::mutex> lock(mutex);
    return units.size();
  };

  std::vector<uint8_t> y(static_cast<size_t>(kWidth) * kHeight);
  std::vector<uint8_t> uv(static_cast<size_t>(kWidth) * (kHeight / 2), 128);
  for (int i = 0; i < kFrames; ++i) {
    for (uint32_t row = 0; row < kHeight; ++row) {
      std::fill(y.begin() + static_cast<std::ptrdiff_t>(row) * kWidth, y.begin() + static_cast<std::ptrdiff_t>(row + 1) * kWidth,
                static_cast<uint8_t>(16 + ((row + static_cast<uint32_t>(i) * 4) % 220)));
    }
    CapturedFrame frame;
    frame.planes[0] = {y.data(), kWidth, kHeight};
    frame.planes[1] = {uv.data(), kWidth, kHeight / 2};
    frame.planeCount = 2;
    frame.width = kWidth;
    frame.height = kHeight;
    frame.pixelFormat = "nv12";
    frame.captureNs = kBaseNs + static_cast<uint64_t>(i) * kFrameNs;
    if (!encoder->encode(frame, i == 30)) fail("encode rejected frame " + std::to_string(i));
    // Paced on the encoder taking the frame, so nothing is replaced in the mailbox.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (mediaFoundationEncoderStats(*encoder).submitted < static_cast<uint64_t>(i) + 1) {
      if (std::chrono::steady_clock::now() > deadline) fail("the encoder did not take frame " + std::to_string(i));
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
  encoder->flush();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (unitCount() < static_cast<size_t>(kFrames) && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  const MfEncoderStats stats = mediaFoundationEncoderStats(*encoder);
  encoder.reset();
  if (!wrapped->state().shutdown) fail("the MFT must be shut down on teardown");

  std::lock_guard<std::mutex> lock(mutex);
  if (stats.submitted != kFrames || stats.dropped != 0) fail("every paced frame must reach the encoder");
  if (stats.drains != 1) fail("flush must complete a drain");
  // A software rate controller may skip a frame; the drain must still bring out the rest.
  if (units.size() < static_cast<size_t>(kFrames) - 4) fail("too few access units after the drain: " + std::to_string(units.size()));
  if (!units.front().keyframe || !containsIdr(units.front().annexB)) fail("first unit must be an IDR");
  if (!containsNalType(units.front().annexB, 7) || !containsNalType(units.front().annexB, 8)) fail("first keyframe without SPS/PPS");
  if (spsProfileIdc(units.front().annexB) != 77) fail("H.264 Main expected, profile_idc " + std::to_string(spsProfileIdc(units.front().annexB)));
  size_t keyframes = 0;
  bool forcedFrameSeen = false;
  bool forcedFrameIsKeyframe = false;
  uint64_t previousNs = 0;
  for (const EncodedAccessUnit &unit : units) {
    if (firstNalType(unit.annexB) < 0) fail("not annex b");
    if (unit.captureNs < kBaseNs || (unit.captureNs - kBaseNs) % kFrameNs != 0) fail("capture timestamp is not one of the submitted frames");
    if (unit.captureNs <= previousNs) fail("capture timestamps must increase");
    previousNs = unit.captureNs;
    if (unit.keyframe) {
      ++keyframes;
      if (!containsNalType(unit.annexB, 7)) fail("keyframe without SPS");
    }
    if (unit.captureNs == kBaseNs + 30 * kFrameNs) {
      forcedFrameSeen = true;
      forcedFrameIsKeyframe = unit.keyframe;
    }
  }
  if (canForce && forcedFrameSeen && !forcedFrameIsKeyframe) fail("forced keyframe must land on the frame it was requested for");
  if (canForce && keyframes < 2) fail("expected the opening and the forced keyframe, got " + std::to_string(keyframes));

  std::cout << "mf_encoder_software_seam_test passed (" << units.size() << " access units, " << keyframes << " keyframes)" << std::endl;
  return 0;
}

int main() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) fail("CoInitializeEx");
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) fail("MFStartup");
  const int result = run();
  MFShutdown();
  CoUninitialize();
  return result;
}
