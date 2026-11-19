#include "live_stream/mf_encoder_policy.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "mf_encoder_policy_test failed: " << m << std::endl; std::exit(1); }

namespace {

const EncoderCandidateInfo kIntel{"Intel\xC2\xAE Quick Sync Video H.264 Encoder MFT", "VEN_8086"};
const EncoderCandidateInfo kNvidia{"NVIDIA H.264 Encoder MFT", "VEN_10DE"};
const EncoderCandidateInfo kAmd{"AMDh264Encoder", "VEN_1002"};
const EncoderCandidateInfo kOther{"Some SoC H264 Encoder", "VEN_5143"};

void testVendors() {
  if (parseEncoderVendor("nvidia") != EncoderVendor::Nvidia || parseEncoderVendor("NVIDIA") != EncoderVendor::Nvidia) fail("parse nvidia");
  if (parseEncoderVendor("intel") != EncoderVendor::Intel || parseEncoderVendor("Amd") != EncoderVendor::Amd) fail("parse intel / amd");
  if (parseEncoderVendor("") != EncoderVendor::Unknown || parseEncoderVendor("software") != EncoderVendor::Unknown ||
      parseEncoderVendor(" nvidia") != EncoderVendor::Unknown) fail("unknown override values mean no preference");
  if (std::string(encoderVendorName(EncoderVendor::Amd)) != "amd" || std::string(encoderVendorName(EncoderVendor::Unknown)) != "unknown") fail("vendor names");

  if (classifyEncoderVendor(kIntel) != EncoderVendor::Intel || classifyEncoderVendor(kNvidia) != EncoderVendor::Nvidia ||
      classifyEncoderVendor(kAmd) != EncoderVendor::Amd || classifyEncoderVendor(kOther) != EncoderVendor::Unknown) fail("classify by vendor id");
  if (classifyEncoderVendor({"NVIDIA H.264 Encoder MFT", ""}) != EncoderVendor::Nvidia ||
      classifyEncoderVendor({"AMDh264Encoder", ""}) != EncoderVendor::Amd ||
      classifyEncoderVendor({"Intel Hardware H264 Encoder MFT", ""}) != EncoderVendor::Intel) fail("classify by name without a vendor id");
  if (classifyEncoderVendor({"H264 Encoder MFT", "ven_10de"}) != EncoderVendor::Nvidia) fail("vendor id is case-insensitive");
  // The id wins over a misleading name.
  if (classifyEncoderVendor({"Intel-branded name", "VEN_1002"}) != EncoderVendor::Amd) fail("vendor id before name");
  if (classifyEncoderVendor({"", ""}) != EncoderVendor::Unknown) fail("empty candidate");
}

void testRanking() {
  using Order = std::vector<size_t>;
  if (!rankEncoderCandidates({}).empty()) fail("no candidates");
  // Hybrid laptop as enumerated: integrated first.
  if (rankEncoderCandidates({kIntel, kNvidia}) != Order{1, 0}) fail("discrete before integrated");
  if (rankEncoderCandidates({kIntel, kAmd}) != Order{1, 0}) fail("amd before intel");
  if (rankEncoderCandidates({kOther, kIntel, kAmd, kNvidia}) != Order{3, 2, 1, 0}) fail("nvidia, amd, intel, unknown");
  // Enumeration order (merit) is kept within a vendor.
  if (rankEncoderCandidates({kNvidia, kIntel, kNvidia, kIntel}) != Order{0, 2, 1, 3}) fail("stable within a vendor");
  if (rankEncoderCandidates({kIntel}) != Order{0}) fail("single candidate");
  // The override moves its vendor to the front and keeps the others as fallbacks.
  if (rankEncoderCandidates({kIntel, kNvidia, kAmd}, EncoderVendor::Intel) != Order{0, 1, 2}) fail("intel override");
  if (rankEncoderCandidates({kIntel, kNvidia, kAmd}, EncoderVendor::Amd) != Order{2, 1, 0}) fail("amd override");
  if (rankEncoderCandidates({kIntel, kNvidia}, EncoderVendor::Amd) != Order{1, 0}) fail("override without a matching encoder changes nothing");
  if (rankEncoderCandidates({kOther, kIntel}, EncoderVendor::Unknown) != Order{1, 0}) fail("no override");
}

void testRateControl() {
  // Preview: hard cap. 1080p60 LAN is 8 / 12 Mbit/s.
  const EncodeTarget preview = selectEncodeTarget(1920, 1080, 60, 1, EncodeProfile::Lan);
  const std::vector<RateControlStep> steps = planRateControl(preview);
  if (steps.size() != 2) fail("preview: peak VBR, then CBR");
  if (steps[0].mode != RateControlMode::PeakConstrainedVbr || steps[0].meanBitrateBps != 8'000'000 ||
      steps[0].maxBitrateBps != 12'000'000 || steps[0].bufferBits != 12'000'000) fail("preview: peak-constrained VBR with mean, max and a 1 s buffer");
  if (steps[1].mode != RateControlMode::Cbr || steps[1].meanBitrateBps != 8'000'000 || steps[1].maxBitrateBps != 0 ||
      steps[1].bufferBits != 8'000'000) fail("preview: CBR fallback at the mean");

  // Archive: no hard cap first.
  const EncodeTarget archive = selectRecordingTarget(1920, 1080, 30, 1);
  const std::vector<RateControlStep> archiveSteps = planRateControl(archive);
  if (archiveSteps.size() != 3) fail("archive: three steps");
  if (archiveSteps[0].mode != RateControlMode::UnconstrainedVbr || archiveSteps[0].meanBitrateBps != archive.bitrateKbps * 1000 ||
      archiveSteps[0].maxBitrateBps != 0 || archiveSteps[0].bufferBits != 0) fail("archive: unconstrained VBR at the mean");
  if (archiveSteps[1].mode != RateControlMode::PeakConstrainedVbr || archiveSteps[1].maxBitrateBps != archive.maxBitrateKbps * 1000) fail("archive: peak VBR fallback");
  if (archiveSteps[2].mode != RateControlMode::Cbr) fail("archive: CBR last");

  // A max below the mean never produces a cap below the mean.
  const RateControlStep odd = rateControlForBitrate(RateControlMode::PeakConstrainedVbr, 3000, 1000);
  if (odd.meanBitrateBps != 3'000'000 || odd.maxBitrateBps != 3'000'000) fail("max is at least the mean");
  const RateControlStep huge = rateControlForBitrate(RateControlMode::Cbr, 0xFFFFFFFFu, 0);
  if (huge.meanBitrateBps != 0xFFFFFFFFu) fail("bitrate conversion must saturate, not wrap");
  if (std::string(rateControlModeName(RateControlMode::PeakConstrainedVbr)) != "peak_vbr" ||
      std::string(rateControlModeName(RateControlMode::Cbr)) != "cbr" ||
      std::string(rateControlModeName(RateControlMode::UnconstrainedVbr)) != "vbr") fail("mode names");
}

void testAttributePlan() {
  const EncoderAttributePlan preview = planEncoderAttributes(selectEncodeTarget(1920, 1080, 60, 1, EncodeProfile::Lan));
  if (preview.width != 1920 || preview.height != 1080 || preview.fpsNum != 60 || preview.fpsDen != 1) fail("preview geometry");
  if (preview.profileIdc != 77) fail("preview is H.264 Main");
  if (preview.gopFrames != 120 || preview.fallbackGopFrames != 60) fail("preview GOP = fps * 2 s, fallback 1 s");
  if (preview.bFrames != 0 || !preview.lowLatency || !preview.cabac) fail("no B-frames, low latency, CABAC");
  if (preview.qualityVsSpeed != 33) fail("preview prefers speed");
  if (preview.frameDurationHns != 166666) fail("frame duration in 100 ns units");
  if (preview.rateControl.size() != 2 || preview.rateControl[0].mode != RateControlMode::PeakConstrainedVbr) fail("preview rate control");
  if (gopFramesFor(preview, true) != 120 || gopFramesFor(preview, false) != 60) fail("gop depends on forced keyframes");

  const EncoderAttributePlan archive = planEncoderAttributes(selectRecordingTarget(1920, 1080, 30000, 1001));
  if (archive.profileIdc != 100) fail("archive is H.264 High");
  if (archive.gopFrames != 59 || archive.fallbackGopFrames != 29) fail("29.97 fps GOP");
  if (archive.qualityVsSpeed != 67) fail("archive prefers quality");
  if (archive.frameDurationHns != 333666) fail("29.97 fps frame duration");
  if (archive.bFrames != 0 || !archive.lowLatency) fail("archive has no frame reordering either");
  if (archive.rateControl.empty() || archive.rateControl[0].mode != RateControlMode::UnconstrainedVbr) fail("archive rate control");

  // Portrait (meeting program) and remote profile.
  const EncoderAttributePlan portrait = planEncoderAttributes(selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Lan));
  if (portrait.width % 2 != 0 || portrait.height % 2 != 0 || portrait.width >= portrait.height) fail("portrait stays portrait and even");
  const EncoderAttributePlan remote = planEncoderAttributes(selectEncodeTarget(1920, 1080, 60, 1, EncodeProfile::Remote));
  if (remote.width != 1280 || remote.height != 720 || remote.gopFrames != 60) fail("remote 720p30");

  // Odd targets are cut to even, degenerate ones stay usable.
  EncodeTarget odd;
  odd.width = 1281;
  odd.height = 721;
  odd.fpsNum = 0;
  odd.fpsDen = 0;
  odd.bitrateKbps = 1000;
  odd.maxBitrateKbps = 1500;
  const EncoderAttributePlan oddPlan = planEncoderAttributes(odd);
  if (oddPlan.width != 1280 || oddPlan.height != 720) fail("odd sizes round down to even");
  if (oddPlan.fpsNum != 30 || oddPlan.fpsDen != 1 || oddPlan.gopFrames != 60) fail("missing frame rate falls back to 30");
  EncodeTarget tiny;
  tiny.width = 3;
  tiny.height = 1;
  const EncoderAttributePlan tinyPlan = planEncoderAttributes(tiny);
  if (tinyPlan.width != 16 || tinyPlan.height != 16) fail("minimum size");
  EncodeTarget slow;
  slow.width = 640;
  slow.height = 360;
  slow.fpsNum = 1;
  slow.fpsDen = 2;
  const EncoderAttributePlan slowPlan = planEncoderAttributes(slow);
  if (slowPlan.gopFrames != 1 || slowPlan.fallbackGopFrames != 1) fail("gop never drops to 0");
}

void testMessages() {
  const std::string none = formatEncoderUnavailable({}, 0);
  if (none != "No hardware H.264 encoder is available (no hardware encoder MFT found, MFTEnumEx 0x00000000).") fail("empty enumeration message");
  if (formatEncoderUnavailable({}, 0x80070005u).find("0x80070005") == std::string::npos) fail("enumeration HRESULT");
  const std::string tried = formatEncoderUnavailable(
      {{"NVIDIA H.264 Encoder MFT", "output_type", 0xC00D36B4u}, {"", "activate", 0x8007000Eu}}, 0);
  if (tried != "No hardware H.264 encoder could be configured (tried NVIDIA H.264 Encoder MFT: output_type 0xC00D36B4; "
               "unnamed encoder: activate 0x8007000E).") fail("tried encoders message");

  if (formatEncoderSettings({}) != "{}") fail("empty settings");
  if (formatEncoderSettings({{"low_latency", "true"}, {"rate_control", "\"cbr\""}, {"gop_frames", "60"}}) !=
      "{\"low_latency\":true,\"rate_control\":\"cbr\",\"gop_frames\":60}") fail("settings json");
}

void testTimestampMap() {
  CaptureTimestampMap map(4);
  // Capture times are nanoseconds, sample times 100 ns: the exact value must come back.
  const uint64_t a = 1'000'000'033ull;
  const uint64_t b = 1'033'333'366ull;
  const uint64_t c = 1'066'666'699ull;
  if (map.push(a) != 10'000'000) fail("sample time is capture time / 100");
  const int64_t tb = map.push(b);
  const int64_t tc = map.push(c);
  if (map.take(10'000'000) != a || map.take(tb) != b || map.take(tc) != c) fail("exact lookup in order");
  if (map.pending() != 0) fail("entries are consumed");

  // An output for a later frame drops the entries of frames the encoder skipped.
  map.push(a);
  map.push(b);
  map.push(c);
  if (map.take(CaptureTimestampMap::sampleTimeFor(b)) != b || map.pending() != 1) fail("older entries dropped on a match");
  if (map.take(CaptureTimestampMap::sampleTimeFor(c)) != c) fail("remaining entry");

  // An encoder that rewrites sample times: first in, first out.
  map.push(a);
  map.push(b);
  if (map.take(42) != a || map.take(-1) != b) fail("fifo without a match");
  // Nothing pending: the sample time itself, in nanoseconds.
  if (map.take(123) != 12'300 || map.take(-1) != 0) fail("fallback to the sample time");

  // Bounded: the oldest entry falls out.
  for (uint64_t i = 0; i < 6; ++i) map.push(1'000 * (i + 1));
  if (map.pending() != 4) fail("capacity");
  if (map.take(CaptureTimestampMap::sampleTimeFor(1'000)) != 3'000) fail("evicted entry must not be found");
  map.clear();
  if (map.pending() != 0) fail("clear");
  CaptureTimestampMap one(0);
  one.push(a);
  one.push(b);
  if (one.pending() != 1 || one.take(-1) != b) fail("capacity 0 is treated as 1");
}

}  // namespace

int main() {
  testVendors();
  testRanking();
  testRateControl();
  testAttributePlan();
  testMessages();
  testTimestampMap();
  std::cout << "mf_encoder_policy_test passed" << std::endl;
  return 0;
}
