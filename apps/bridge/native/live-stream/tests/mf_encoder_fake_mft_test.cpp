// Media Foundation encoder against an in-test asynchronous MFT: no hardware,
// no real codec. Covers what the encoder owes every hardware MFT: the
// configuration order, the event loop with input credits, the one-slot
// mailbox, forced keyframes, a stream change, drain, candidate fallback and a
// clean shutdown. Windows only (LIVE_STREAM_WITH_MF).
#include <windows.h>

#include <initguid.h>
#include <cguid.h>

#include "mf_encoder_internal.h"
#include "mf_fake_async_mft.h"

#include "live_stream/h264_annexb.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::live;
using broadify::live::test::FakeAsyncEncoderMft;
using broadify::live::test::FakeMftOptions;
using Microsoft::WRL::ComPtr;

static void fail(const std::string &m) {
  std::cerr << "mf_encoder_fake_mft_test failed: " << m << std::endl;
  std::exit(1);
}

namespace {

constexpr uint32_t kWidth = 320;
constexpr uint32_t kHeight = 180;
constexpr uint64_t kFrameNs = 33'333'333ull;
constexpr uint64_t kBaseNs = 5'000'000'007ull;  // not a multiple of 100 ns: the mapping must restore it exactly

uint64_t captureNsOf(int index) { return kBaseNs + static_cast<uint64_t>(index) * kFrameNs; }

bool waitFor(const std::function<bool()> &condition, int timeoutMs = 5000) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (!condition()) {
    if (std::chrono::steady_clock::now() > deadline) {
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return true;
}

ComPtr<FakeAsyncEncoderMft> makeFake(const FakeMftOptions &options) {
  ComPtr<FakeAsyncEncoderMft> fake;
  fake.Attach(new FakeAsyncEncoderMft(options));
  return fake;
}

MfEncoderCandidate candidateFor(const ComPtr<FakeAsyncEncoderMft> &fake, const std::string &name,
                                const std::string &vendorId) {
  MfEncoderCandidate candidate;
  candidate.name = name;
  candidate.vendorId = vendorId;
  candidate.hardware = true;
  candidate.activate = [fake](IMFTransform **transform) {
    *transform = static_cast<IMFTransform *>(fake.Get());
    (*transform)->AddRef();
    return S_OK;
  };
  return candidate;
}

struct Nv12Frame {
  std::vector<uint8_t> y;
  std::vector<uint8_t> uv;
  CapturedFrame frame;
  Nv12Frame(uint32_t width, uint32_t height, uint8_t luma, uint64_t captureNs)
      : y(static_cast<size_t>(width) * height, luma), uv(static_cast<size_t>(width) * (height / 2), 128) {
    frame.planes[0] = {y.data(), width, height};
    frame.planes[1] = {uv.data(), width, height / 2};
    frame.planeCount = 2;
    frame.width = width;
    frame.height = height;
    frame.pixelFormat = "nv12";
    frame.captureNs = captureNs;
  }
};

// One encoder on top of the given candidates, collecting its access units.
struct Harness {
  std::unique_ptr<VideoEncoder> encoder;
  std::mutex mutex;
  std::vector<EncodedAccessUnit> units;

  explicit Harness(std::vector<MfEncoderCandidate> candidates, const std::string &preferredVendor = "") {
    encoder = createMediaFoundationEncoder(
        [candidates](std::vector<MfEncoderCandidate> &out) {
          out = candidates;
          return S_OK;
        },
        preferredVendor);
    encoder->onAccessUnit = [this](EncodedAccessUnit &&unit) {
      std::lock_guard<std::mutex> lock(mutex);
      units.push_back(std::move(unit));
    };
  }

  bool configure(std::string &code, std::string &error, EncodeTarget target = selectEncodeTarget(kWidth, kHeight, 30, 1, EncodeProfile::Lan)) {
    return encoder->configure(target, code, error);
  }

  void mustConfigure(const char *what) {
    std::string code;
    std::string error;
    if (!configure(code, error)) fail(std::string(what) + ": configure failed: " + error);
  }

  size_t unitCount() {
    std::lock_guard<std::mutex> lock(mutex);
    return units.size();
  }

  EncodedAccessUnit unit(size_t index) {
    std::lock_guard<std::mutex> lock(mutex);
    return units.at(index);
  }

  // Encodes one frame and waits until its access unit arrived (paced, so nothing is dropped).
  void encodePaced(int index, bool forceKeyframe, const char *what) {
    const size_t before = unitCount();
    Nv12Frame frame(kWidth, kHeight, static_cast<uint8_t>(16 + index), captureNsOf(index));
    if (!encoder->encode(frame.frame, forceKeyframe)) fail(std::string(what) + ": encode rejected a frame");
    if (!waitFor([&] { return unitCount() > before; })) fail(std::string(what) + ": no access unit for a frame");
  }
};

size_t countNals(const std::vector<uint8_t> &annexB, int type) {
  size_t count = 0;
  for (size_t i = 0; i + 4 < annexB.size(); ++i) {
    if (annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 1 && (annexB[i + 3] & 0x1f) == type) {
      ++count;
    }
  }
  return count;
}

bool containsBytes(const std::vector<uint8_t> &haystack, const std::vector<uint8_t> &needle) {
  if (needle.empty() || haystack.size() < needle.size()) {
    return false;
  }
  for (size_t i = 0; i + needle.size() <= haystack.size(); ++i) {
    if (memcmp(haystack.data() + i, needle.data(), needle.size()) == 0) {
      return true;
    }
  }
  return false;
}

ULONG codecNumber(const ComPtr<FakeAsyncEncoderMft> &fake, const GUID &api, const char *what) {
  ULONG number = 0;
  if (!fake->codecValue(api, number)) fail(std::string("codec value never set: ") + what);
  return number;
}

void testConfigureAndEncode() {
  auto fake = makeFake({});
  Harness h({candidateFor(fake, "Fake H.264 Encoder MFT", "VEN_10DE")});
  h.mustConfigure("basic");

  const EncoderInfo info = h.encoder->info();
  if (info.backend != "mediafoundation" || !info.hardware) fail("basic: backend / hardware flag");
  if (info.name != "Fake H.264 Encoder MFT" || info.vendorId != "VEN_10DE") fail("basic: name / vendor id");
  if (info.settings.find("\"force_keyframe\":true") == std::string::npos) fail("basic: force_keyframe not reported: " + info.settings);
  if (info.settings.find("\"rate_control\":\"peak_vbr\"") == std::string::npos) fail("basic: rate control not reported: " + info.settings);
  if (info.settings.find("\"gop_frames\":60") == std::string::npos) fail("basic: gop not reported: " + info.settings);
  if (info.settings.find("\"color_signalled\":true") == std::string::npos) fail("basic: colour not reported: " + info.settings);

  auto state = fake->state();
  if (!state.asyncUnlocked) fail("basic: MF_TRANSFORM_ASYNC_UNLOCK not set");
  if (!state.lowLatencyAttribute) fail("basic: MF_LOW_LATENCY not set");
  if (!state.outputTypeSetBeforeInputType) fail("basic: input type must follow the output type");
  if (!state.inputIsNv12 || !state.inputColorSignalled) fail("basic: input type must be NV12, BT.709, 16-235");
  if (state.inputWidth != kWidth || state.inputHeight != kHeight) fail("basic: input frame size");
  if (state.outputProfile != 77) fail("basic: output profile must be Main");
  const EncodeTarget target = selectEncodeTarget(kWidth, kHeight, 30, 1, EncodeProfile::Lan);
  if (state.outputBitrate != target.bitrateKbps * 1000) fail("basic: MF_MT_AVG_BITRATE");
  if (state.beginStreaming != 1 || state.startOfStream != 1) fail("basic: streaming start messages");

  if (codecNumber(fake, CODECAPI_AVEncCommonRateControlMode, "rate control") != eAVEncCommonRateControlMode_PeakConstrainedVBR) fail("basic: rate control mode");
  if (codecNumber(fake, CODECAPI_AVEncCommonMeanBitRate, "mean") != target.bitrateKbps * 1000) fail("basic: mean bitrate");
  if (codecNumber(fake, CODECAPI_AVEncCommonMaxBitRate, "max") != target.maxBitrateKbps * 1000) fail("basic: max bitrate");
  if (codecNumber(fake, CODECAPI_AVEncCommonBufferSize, "buffer") != target.maxBitrateKbps * 1000) fail("basic: 1 s buffer");
  if (codecNumber(fake, CODECAPI_AVLowLatencyMode, "low latency") != 1) fail("basic: low latency mode");
  if (codecNumber(fake, CODECAPI_AVEncMPVGOPSize, "gop") != 60) fail("basic: GOP = fps * gopSeconds");
  if (codecNumber(fake, CODECAPI_AVEncMPVDefaultBPictureCount, "b frames") != 0) fail("basic: B-frames must be 0");
  if (codecNumber(fake, CODECAPI_AVEncH264CABACEnable, "cabac") != 1) fail("basic: CABAC");

  for (int i = 0; i < 10; ++i) {
    if (i == 6) h.encoder->requestKeyframe();
    h.encodePaced(i, i == 8, "basic");
  }
  if (h.unitCount() != 10) fail("basic: one access unit per frame");
  for (int i = 0; i < 10; ++i) {
    const EncodedAccessUnit unit = h.unit(static_cast<size_t>(i));
    if (unit.captureNs != captureNsOf(i)) fail("basic: capture timestamp not restored exactly");
    if (unit.annexB.size() < 5 || unit.annexB[0] != 0 || unit.annexB[1] != 0) fail("basic: not Annex B");
    const bool expectKey = i == 0 || i == 6 || i == 8;
    if (unit.keyframe != expectKey) fail("basic: keyframe flag of frame " + std::to_string(i));
    if (expectKey) {
      // The fake keeps its parameter sets out of band: the encoder has to prepend them.
      if (firstNalType(unit.annexB) != 7 || !containsNalType(unit.annexB, 8) || !containsIdr(unit.annexB)) fail("basic: keyframe without SPS/PPS in front");
      if (!containsBytes(unit.annexB, test::fakeSps())) fail("basic: SPS must come from MF_MT_MPEG_SEQUENCE_HEADER");
    } else if (containsNalType(unit.annexB, 7)) {
      fail("basic: parameter sets on a delta frame");
    }
  }
  state = fake->state();
  if (state.forcedKeyframes != 3) fail("basic: first frame, requestKeyframe and encode(force) must each force one keyframe");
  if (state.lastInputLength != kWidth * kHeight * 3 / 2) fail("basic: input sample must be one contiguous NV12 frame");
  if (state.lastInputFirstByte != 16 + 9) fail("basic: input sample does not carry the frame's pixels");
  if (state.inputTimes.size() != 10 || state.inputTimes[3] != static_cast<LONGLONG>(captureNsOf(3) / 100)) fail("basic: sample time must be the capture time in 100 ns units");
  const MfEncoderStats stats = mediaFoundationEncoderStats(*h.encoder);
  if (stats.received != 10 || stats.submitted != 10 || stats.encoded != 10 || stats.dropped != 0 || stats.errors != 0) fail("basic: stats");
  if (stats.forcedKeyframes != 3) fail("basic: forced keyframe stat");

  // Bitrate change at run time goes to the encoder thread and onto ICodecAPI.
  h.encoder->setBitrate(1200, 1800);
  if (!waitFor([&] {
        // The buffer size is the last value of a rate change.
        ULONG buffer = 0;
        return fake->codecValue(CODECAPI_AVEncCommonBufferSize, buffer) && buffer == 1'800'000;
      })) fail("basic: setBitrate did not reach the encoder");
  if (codecNumber(fake, CODECAPI_AVEncCommonMeanBitRate, "mean") != 1'200'000) fail("basic: setBitrate mean");
  if (codecNumber(fake, CODECAPI_AVEncCommonMaxBitRate, "max") != 1'800'000) fail("basic: setBitrate max");
  if (codecNumber(fake, CODECAPI_AVEncCommonRateControlMode, "rate control") != eAVEncCommonRateControlMode_PeakConstrainedVBR) fail("basic: setBitrate must keep the rate control mode");

  h.encoder.reset();
  if (!fake->state().shutdown) fail("basic: IMFShutdown::Shutdown not called on teardown");
}

void testMailboxDropsAndForcedKeyframeCarryOver() {
  FakeMftOptions options;
  options.manualCredits = true;
  auto fake = makeFake(options);
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("mailbox");

  // No input requested yet: the frames only ever occupy the one mailbox slot.
  Nv12Frame a(kWidth, kHeight, 20, captureNsOf(0));
  Nv12Frame b(kWidth, kHeight, 21, captureNsOf(1));
  Nv12Frame c(kWidth, kHeight, 22, captureNsOf(2));
  const auto start = std::chrono::steady_clock::now();
  if (!h.encoder->encode(a.frame, false) || !h.encoder->encode(b.frame, false) || !h.encoder->encode(c.frame, false)) fail("mailbox: encode must accept frames while the encoder is busy");
  const auto elapsed = std::chrono::steady_clock::now() - start;
  if (elapsed > std::chrono::milliseconds(500)) fail("mailbox: encode blocked");
  MfEncoderStats stats = mediaFoundationEncoderStats(*h.encoder);
  if (stats.received != 3 || stats.dropped != 2 || stats.submitted != 0) fail("mailbox: two of three frames must be counted as dropped");
  if (fake->state().inputs != 0) fail("mailbox: input without a METransformNeedInput");

  fake->grantInput(1);
  if (!waitFor([&] { return h.unitCount() == 1; })) fail("mailbox: latest frame not encoded after the input request");
  // The first frame of the stream is forced; frame A carried that flag and was replaced twice.
  EncodedAccessUnit first = h.unit(0);
  if (first.captureNs != captureNsOf(2)) fail("mailbox: the newest frame must win");
  if (!first.keyframe || fake->state().forcedKeyframes != 1) fail("mailbox: forced keyframe lost with the replaced frame");
  if (fake->state().lastInputFirstByte != 22) fail("mailbox: wrong frame submitted");

  // A requested keyframe survives a drop the same way.
  Nv12Frame d(kWidth, kHeight, 23, captureNsOf(3));
  Nv12Frame e(kWidth, kHeight, 24, captureNsOf(4));
  if (!h.encoder->encode(d.frame, true) || !h.encoder->encode(e.frame, false)) fail("mailbox: encode rejected");
  fake->grantInput(2);
  if (!waitFor([&] { return h.unitCount() == 2; })) fail("mailbox: second access unit");
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  if (h.unitCount() != 2) fail("mailbox: a dropped frame was encoded");
  if (h.unit(1).captureNs != captureNsOf(4) || !h.unit(1).keyframe) fail("mailbox: forced keyframe must move to the replacing frame");
  stats = mediaFoundationEncoderStats(*h.encoder);
  if (stats.received != 5 || stats.dropped != 3 || stats.submitted != 2 || stats.encoded != 2) fail("mailbox: final stats");
  if (fake->state().notAccepting != 0) fail("mailbox: ProcessInput called without credit");
}

void testProvidedSamplesAndInBandParameterSets() {
  FakeMftOptions options;
  options.providesSamples = true;
  options.parameterSetsInBand = true;
  auto fake = makeFake(options);
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("provided");
  for (int i = 0; i < 4; ++i) h.encodePaced(i, false, "provided");
  const EncodedAccessUnit key = h.unit(0);
  if (!key.keyframe || firstNalType(key.annexB) != 7) fail("provided: keyframe with in-band SPS");
  if (countNals(key.annexB, 7) != 1 || countNals(key.annexB, 8) != 1) fail("provided: parameter sets must not be prepended twice");
  if (h.unit(3).captureNs != captureNsOf(3)) fail("provided: timestamps");
  if (mediaFoundationEncoderStats(*h.encoder).errors != 0) fail("provided: MFT-allocated samples must be accepted");
}

void testStreamChange() {
  FakeMftOptions options;
  options.streamChangeAtOutput = 2;
  auto fake = makeFake(options);
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("stream change");
  for (int i = 0; i < 6; ++i) h.encodePaced(i, i == 4, "stream change");
  if (h.unitCount() != 6) fail("stream change: the frame at the change must not be lost");
  for (int i = 0; i < 6; ++i) {
    if (h.unit(static_cast<size_t>(i)).captureNs != captureNsOf(i)) fail("stream change: order / timestamps");
  }
  const MfEncoderStats stats = mediaFoundationEncoderStats(*h.encoder);
  if (stats.streamChanges != 1 || stats.errors != 0) fail("stream change: must be renegotiated exactly once without an error");
  // Keyframes after the change carry the parameter sets of the new output type.
  if (!containsBytes(h.unit(0).annexB, test::fakeSps())) fail("stream change: first keyframe uses the initial SPS");
  const EncodedAccessUnit later = h.unit(4);
  if (!later.keyframe || !containsBytes(later.annexB, test::fakeSpsAfterChange())) fail("stream change: parameter sets not re-read");
}

void testFlushDrains() {
  auto fake = makeFake({});
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("flush");
  for (int i = 0; i < 3; ++i) h.encodePaced(i, false, "flush");
  h.encoder->flush();
  auto state = fake->state();
  if (state.drains != 1) fail("flush: MFT_MESSAGE_COMMAND_DRAIN must complete");
  if (state.startOfStream != 2) fail("flush: the stream must be restarted after the drain");
  if (mediaFoundationEncoderStats(*h.encoder).drains != 1) fail("flush: drain stat");
  // Encoding continues, on a keyframe.
  h.encodePaced(3, false, "flush");
  if (!h.unit(3).keyframe || h.unit(3).captureNs != captureNsOf(3)) fail("flush: first frame after a flush must be a keyframe");
  h.encoder->flush();
  if (fake->state().drains != 2) fail("flush: second flush");
}

void testForceKeyframeUnsupported() {
  FakeMftOptions options;
  options.supportForceKeyframe = false;
  options.supportPeakVbr = false;
  options.rejectColorOnInputType = true;
  auto fake = makeFake(options);
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("limited");
  const EncoderInfo info = h.encoder->info();
  if (info.settings.find("\"force_keyframe\":false") == std::string::npos) fail("limited: force_keyframe:false not reported: " + info.settings);
  // Without forced keyframes the GOP shrinks to one second.
  if (codecNumber(fake, CODECAPI_AVEncMPVGOPSize, "gop") != 30) fail("limited: GOP must be 1 s");
  if (info.settings.find("\"gop_frames\":30") == std::string::npos) fail("limited: gop report: " + info.settings);
  // No settable peak: CBR instead of an uncapped VBR.
  if (codecNumber(fake, CODECAPI_AVEncCommonRateControlMode, "rate control") != eAVEncCommonRateControlMode_CBR) fail("limited: CBR fallback");
  if (info.settings.find("\"rate_control\":\"cbr\"") == std::string::npos) fail("limited: rate control report: " + info.settings);
  if (info.settings.find("\"color_signalled\":false") == std::string::npos) fail("limited: colour report: " + info.settings);
  if (!fake->state().inputIsNv12) fail("limited: input type without colour attributes must still be set");
  for (int i = 0; i < 3; ++i) h.encodePaced(i, i == 1, "limited");
  if (fake->state().forcedKeyframes != 0) fail("limited: unsupported force keyframe must not be set");
  if (!h.unit(0).keyframe || h.unit(1).keyframe) fail("limited: keyframes come from the GOP only");
}

void testCandidateFallbackAndErrors() {
  // First candidate cannot take the output type, second is not asynchronous, third works.
  FakeMftOptions broken;
  broken.setOutputTypeResult = MF_E_INVALIDMEDIATYPE;
  FakeMftOptions synchronous;
  synchronous.async = false;
  auto first = makeFake(broken);
  auto second = makeFake(synchronous);
  auto third = makeFake({});
  {
    Harness h({candidateFor(first, "Broken Encoder", "VEN_10DE"), candidateFor(second, "Sync Encoder", "VEN_10DE"),
               candidateFor(third, "Working Encoder", "VEN_10DE")});
    h.mustConfigure("fallback");
    if (h.encoder->info().name != "Working Encoder") fail("fallback: third candidate must be chosen");
    if (!first->state().shutdown || !second->state().shutdown) fail("fallback: refused candidates must be shut down");
    if (second->state().asyncUnlocked) fail("fallback: a synchronous MFT must be refused before it is touched");
    h.encodePaced(0, false, "fallback");
  }

  // Nothing configures: encoder_unavailable naming every tried encoder with its HRESULT.
  {
    auto a = makeFake(broken);
    auto b = makeFake(synchronous);
    Harness h({candidateFor(a, "Broken Encoder", ""), candidateFor(b, "Sync Encoder", "")});
    std::string code;
    std::string error;
    if (h.configure(code, error)) fail("unavailable: configure must fail");
    if (code != "encoder_unavailable") fail("unavailable: error code " + code);
    if (error.find("Broken Encoder: output_type 0xC00D36B4") == std::string::npos) fail("unavailable: first attempt missing: " + error);
    if (error.find("Sync Encoder: async_required") == std::string::npos) fail("unavailable: second attempt missing: " + error);
    Nv12Frame frame(kWidth, kHeight, 30, captureNsOf(0));
    if (h.encoder->encode(frame.frame, false)) fail("unavailable: encode must be rejected");
    h.encoder->flush();
    h.encoder->setBitrate(1000, 2000);
    h.encoder->requestKeyframe();
  }

  // No candidate at all.
  {
    Harness h({});
    std::string code;
    std::string error;
    if (h.configure(code, error) || code != "encoder_unavailable") fail("empty: configure must fail with encoder_unavailable");
    if (error.find("no hardware encoder MFT found") == std::string::npos) fail("empty: message: " + error);
  }

  // Enumeration itself fails.
  {
    auto encoder = createMediaFoundationEncoder([](std::vector<MfEncoderCandidate> &) { return E_ACCESSDENIED; }, "");
    std::string code;
    std::string error;
    if (encoder->configure(selectEncodeTarget(kWidth, kHeight, 30, 1, EncodeProfile::Lan), code, error)) fail("enum failure: configure must fail");
    if (code != "encoder_unavailable" || error.find("0x80070005") == std::string::npos) fail("enum failure: message: " + error);
  }
}

void testVendorRanking() {
  auto intel = makeFake({});
  auto nvidia = makeFake({});
  {
    Harness h({candidateFor(intel, "Intel Quick Sync Video H.264 Encoder MFT", "VEN_8086"),
               candidateFor(nvidia, "NVIDIA H.264 Encoder MFT", "VEN_10DE")});
    h.mustConfigure("ranking");
    if (h.encoder->info().name != "NVIDIA H.264 Encoder MFT") fail("ranking: discrete GPU first");
    if (intel->state().asyncUnlocked) fail("ranking: the integrated encoder must not be touched");
  }
  auto intel2 = makeFake({});
  auto nvidia2 = makeFake({});
  {
    Harness h({candidateFor(intel2, "Intel Quick Sync Video H.264 Encoder MFT", "VEN_8086"),
               candidateFor(nvidia2, "NVIDIA H.264 Encoder MFT", "VEN_10DE")},
              "intel");
    h.mustConfigure("ranking override");
    if (h.encoder->info().name != "Intel Quick Sync Video H.264 Encoder MFT") fail("ranking: vendor override");
  }
}

void testInputFormats() {
  auto fake = makeFake({});
  Harness h({candidateFor(fake, "Fake", "")});
  h.mustConfigure("formats");

  // A larger YUY2 frame is converted and scaled to the encode size.
  const uint32_t w = kWidth * 2;
  const uint32_t ht = kHeight * 2;
  std::vector<uint8_t> yuy2(static_cast<size_t>(w) * 2 * ht);
  for (size_t i = 0; i < yuy2.size(); i += 2) {
    yuy2[i] = 77;
    yuy2[i + 1] = 128;
  }
  CapturedFrame packed;
  packed.planes[0] = {yuy2.data(), w * 2, ht};
  packed.planeCount = 1;
  packed.width = w;
  packed.height = ht;
  packed.pixelFormat = "yuy2";
  packed.captureNs = captureNsOf(0);
  if (!h.encoder->encode(packed, false)) fail("formats: YUY2 rejected");
  if (!waitFor([&] { return h.unitCount() == 1; })) fail("formats: YUY2 frame not encoded");
  auto state = fake->state();
  if (state.lastInputLength != kWidth * kHeight * 3 / 2 || state.lastInputFirstByte != 77) fail("formats: YUY2 must arrive as NV12 of the encode size");

  // An NV12 sample of the encode size is handed on without a copy.
  ComPtr<IMFMediaBuffer> buffer;
  ComPtr<IMFSample> sample;
  const DWORD size = kWidth * kHeight * 3 / 2;
  if (FAILED(MFCreateMemoryBuffer(size, &buffer)) || FAILED(MFCreateSample(&sample)) || FAILED(sample->AddBuffer(buffer.Get()))) fail("formats: native sample");
  BYTE *data = nullptr;
  buffer->Lock(&data, nullptr, nullptr);
  memset(data, 99, size);
  buffer->Unlock();
  buffer->SetCurrentLength(size);
  sample->SetSampleTime(123);
  CapturedFrame native;
  native.nativeHandle = sample.Get();
  native.width = kWidth;
  native.height = kHeight;
  native.pixelFormat = "nv12";
  native.captureNs = captureNsOf(1);
  if (!h.encoder->encode(native, false)) fail("formats: native sample rejected");
  if (!waitFor([&] { return h.unitCount() == 2; })) fail("formats: native sample not encoded");
  state = fake->state();
  if (state.lastInputBuffer != buffer.Get()) fail("formats: native NV12 sample must be passed without a copy");
  if (state.inputTimes.back() != static_cast<LONGLONG>(captureNsOf(1) / 100)) fail("formats: native sample must be stamped with the capture time");
  LONGLONG untouched = 0;
  sample->GetSampleTime(&untouched);
  if (untouched != 123) fail("formats: the capturer's sample must keep its own timestamp");
  if (h.unit(1).captureNs != captureNsOf(1)) fail("formats: native sample timestamp");

  // Unknown formats and frames without pixels are refused, not encoded as garbage.
  CapturedFrame unknown = packed;
  unknown.pixelFormat = "p010";
  if (h.encoder->encode(unknown, false)) fail("formats: unknown pixel format accepted");
  CapturedFrame empty;
  empty.width = kWidth;
  empty.height = kHeight;
  empty.pixelFormat = "nv12";
  if (h.encoder->encode(empty, false)) fail("formats: frame without planes accepted");
  if (mediaFoundationEncoderStats(*h.encoder).rejected != 2) fail("formats: rejected stat");
}

void testShutdownWithPendingWork() {
  FakeMftOptions options;
  options.manualCredits = true;
  auto fake = makeFake(options);
  auto delivered = std::make_shared<std::atomic<int>>(0);
  {
    Harness h({candidateFor(fake, "Fake", "")});
    h.encoder->onAccessUnit = [delivered](EncodedAccessUnit &&) { ++*delivered; };
    h.mustConfigure("shutdown");
    Nv12Frame frame(kWidth, kHeight, 40, captureNsOf(0));
    if (!h.encoder->encode(frame.frame, false)) fail("shutdown: encode rejected");
    const auto start = std::chrono::steady_clock::now();
    h.encoder.reset();  // a frame is still waiting for an input request
    if (std::chrono::steady_clock::now() - start > std::chrono::seconds(2)) fail("shutdown: teardown took too long");
  }
  if (!fake->state().shutdown) fail("shutdown: MFT not shut down");
  if (delivered->load() != 0) fail("shutdown: access unit delivered for a frame that was never submitted");

  // Reconfiguring replaces the session: the old MFT is shut down, the new one encodes.
  auto first = makeFake({});
  auto second = makeFake({});
  int activation = 0;
  std::vector<MfEncoderCandidate> candidates = {candidateFor(first, "First", "")};
  candidates[0].activate = [&, first, second](IMFTransform **transform) {
    *transform = static_cast<IMFTransform *>(activation++ == 0 ? first.Get() : second.Get());
    (*transform)->AddRef();
    return S_OK;
  };
  Harness h(candidates);
  h.mustConfigure("reconfigure 1");
  h.encodePaced(0, false, "reconfigure 1");
  h.mustConfigure("reconfigure 2");
  if (!first->state().shutdown) fail("reconfigure: previous MFT must be shut down");
  h.encodePaced(1, false, "reconfigure 2");
  if (second->state().inputs != 1 || !h.unit(1).keyframe) fail("reconfigure: new session must start on a keyframe");
}

}  // namespace

int main() {
  // The fakes are Media Foundation objects of the test thread; the encoder starts the platform for its own thread.
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) fail("CoInitializeEx");
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) fail("MFStartup");
  testConfigureAndEncode();
  testMailboxDropsAndForcedKeyframeCarryOver();
  testProvidedSamplesAndInBandParameterSets();
  testStreamChange();
  testFlushDrains();
  testForceKeyframeUnsupported();
  testCandidateFallbackAndErrors();
  testVendorRanking();
  testInputFormats();
  testShutdownWithPendingWork();
  MFShutdown();
  CoUninitialize();
  std::cout << "mf_encoder_fake_mft_test passed" << std::endl;
  return 0;
}
