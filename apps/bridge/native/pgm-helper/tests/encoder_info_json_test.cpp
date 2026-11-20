// The encoder identity in pgm_encoder_configured and pgm_status.encoder: which
// encoder MFT was picked has to be readable from the event log, and nothing an
// encoder reports about itself may break the one-JSON-object-per-line format.
#include "common/encoder_info_json.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using namespace broadify::pgm;
using broadify::live::EncoderInfo;

static void fail(const std::string &m) { std::cerr << "encoder_info_json_test failed: " << m << std::endl; std::exit(1); }

static void expectMembers(const EncoderInfo &info, const std::string &expected, const char *what) {
  const std::string actual = encoderDetailJsonMembers(info);
  if (actual != expected) fail(std::string(what) + "\n  expected: " + expected + "\n  actual:   " + actual);
}

static EncoderInfo mediaFoundation(const std::string &name, const std::string &vendorId, const std::string &settings) {
  EncoderInfo info;
  info.backend = "mediafoundation";
  info.hardware = true;
  info.name = name;
  info.vendorId = vendorId;
  info.settings = settings;
  return info;
}

int main() {
  // VideoToolbox reports no name, vendor or settings: nothing is added, the macOS status stays as it was.
  EncoderInfo videoToolbox;
  videoToolbox.backend = "videotoolbox";
  videoToolbox.hardware = true;
  expectMembers(videoToolbox, "", "videotoolbox adds nothing");
  expectMembers(EncoderInfo(), "", "empty info adds nothing");

  // What the Media Foundation encoder reports (settings as mf_encoder.cpp formats them).
  const std::string settings =
      "{\"codec_api\":true,\"rate_control\":\"peak_vbr\",\"low_latency\":true,\"gop_frames\":60,\"b_frames_off\":true,"
      "\"cabac\":true,\"quality_vs_speed\":true,\"force_keyframe\":true,\"color_signalled\":true}";
  expectMembers(mediaFoundation("NVIDIA H.264 Encoder MFT", "VEN_10DE", settings),
                ",\"name\":\"NVIDIA H.264 Encoder MFT\",\"vendor_id\":\"VEN_10DE\",\"vendor\":\"nvidia\",\"settings\":" + settings,
                "nvidia with settings");

  // Fallbacks an encoder took are part of the settings object: no forced keyframes, default rate control, no GOP.
  const std::string fallbacks =
      "{\"codec_api\":true,\"rate_control\":\"default\",\"low_latency\":false,\"gop_frames\":null,\"b_frames_off\":false,"
      "\"cabac\":false,\"quality_vs_speed\":false,\"force_keyframe\":false,\"color_signalled\":false}";
  // The registered-trademark sign of the real friendly name, as UTF-8.
  expectMembers(mediaFoundation("Intel\xC2\xAE Quick Sync Video H.264 Encoder MFT", "VEN_8086", fallbacks),
                ",\"name\":\"Intel\xC2\xAE Quick Sync Video H.264 Encoder MFT\",\"vendor_id\":\"VEN_8086\",\"vendor\":\"intel\",\"settings\":" +
                    fallbacks,
                "intel with fallbacks");

  // Each member only when the encoder reports it; the vendor class needs a name or a vendor id.
  expectMembers(mediaFoundation("AMDh264Encoder", "", ""), ",\"name\":\"AMDh264Encoder\",\"vendor\":\"amd\"", "name only");
  expectMembers(mediaFoundation("", "VEN_10DE", ""), ",\"vendor_id\":\"VEN_10DE\",\"vendor\":\"nvidia\"", "vendor id only");
  expectMembers(mediaFoundation("Some SoC H264 Encoder", "VEN_5143", ""),
                ",\"name\":\"Some SoC H264 Encoder\",\"vendor_id\":\"VEN_5143\",\"vendor\":\"unknown\"", "unknown vendor");
  expectMembers(mediaFoundation("", "", "{}"), ",\"settings\":{}", "settings only");

  // A driver-supplied name is escaped completely, control characters included.
  expectMembers(mediaFoundation(std::string("Enc \"X\" \\ v1\t\r\n") + '\x01' + "end", "", ""),
                ",\"name\":\"Enc \\\"X\\\" \\\\ v1\\t\\r\\n\\u0001end\",\"vendor\":\"unknown\"", "escaped name");
  expectMembers(mediaFoundation("", "VEN_\"10DE\"", ""), ",\"vendor_id\":\"VEN_\\\"10DE\\\"\",\"vendor\":\"nvidia\"", "escaped vendor id");

  // Any single-line JSON object is embedded as it is.
  for (const char *valid : {"{}", "{ \"a\" : 1 }", "{\"a\":{\"b\":[1,2.5,-3e2,0,-0.5E+7,true,false,null,\"x\\\"y\\\\z\\u00e9\\/\"],\"c\":[]}}",
                            "{\"nested\":[[[{\"deep\":{}}]]]}"}) {
    expectMembers(mediaFoundation("", "", valid), std::string(",\"settings\":") + valid, valid);
  }

  // Anything else would break the line it is embedded in: passed on as an escaped string under its own name.
  const char *const broken[][2] = {
      {"{\"rate_control\":peak}", "{\\\"rate_control\\\":peak}"},
      {"{\"a\":1", "{\\\"a\\\":1"},
      {"{\"a\":1}}", "{\\\"a\\\":1}}"},
      {"{\"a\":1}{\"b\":2}", "{\\\"a\\\":1}{\\\"b\\\":2}"},
      {"{\"a\":1,}", "{\\\"a\\\":1,}"},
      {"{\"a\":01}", "{\\\"a\\\":01}"},
      {"{\"a\":1.}", "{\\\"a\\\":1.}"},
      {"{\"a\":+1}", "{\\\"a\\\":+1}"},
      {"{\"a\":tru}", "{\\\"a\\\":tru}"},
      {"{a:1}", "{a:1}"},
      {"{\"a\" 1}", "{\\\"a\\\" 1}"},
      {"{\"a\":\"\\x\"}", "{\\\"a\\\":\\\"\\\\x\\\"}"},
      {"{\"a\":\"\\u12g4\"}", "{\\\"a\\\":\\\"\\\\u12g4\\\"}"},
      {"{\"a\":\"open}", "{\\\"a\\\":\\\"open}"},
      {"{\"a\":[1,]}", "{\\\"a\\\":[1,]}"},
      {"[\"not\",\"an\",\"object\"]", "[\\\"not\\\",\\\"an\\\",\\\"object\\\"]"},
      {"\"text\"", "\\\"text\\\""},
      {"not json", "not json"},
      {" ", " "},
      // Valid JSON, but a line break would split the event line in two.
      {"{\"a\":1,\n\"b\":2}", "{\\\"a\\\":1,\\n\\\"b\\\":2}"},
      {"{\"a\":1}\r\n", "{\\\"a\\\":1}\\r\\n"},
      // A raw tab inside a string is not valid JSON.
      {"{\"a\":\"x\ty\"}", "{\\\"a\\\":\\\"x\\ty\\\"}"},
  };
  for (const auto &entry : broken) {
    expectMembers(mediaFoundation("", "", entry[0]), std::string(",\"settings_text\":\"") + entry[1] + "\"", entry[0]);
  }

  // Nesting far beyond anything an encoder reports is not embedded either.
  std::string deep;
  for (int i = 0; i < 40; ++i) deep += "{\"a\":";
  deep += "1";
  for (int i = 0; i < 40; ++i) deep += "}";
  if (encoderDetailJsonMembers(mediaFoundation("", "", deep)).rfind(",\"settings_text\":\"", 0) != 0) fail("deep nesting must not be embedded");

  // --probe: the enumerated encoders in the order the encoder tries them, not in enumeration order.
  using broadify::live::EncoderCandidateInfo;
  using broadify::live::EncoderVendor;
  const std::vector<EncoderCandidateInfo> hybrid = {
      {"Intel\xC2\xAE Quick Sync Video H.264 Encoder MFT", "VEN_8086"}, {"Some SoC H264 Encoder", "VEN_5143"}, {"NVIDIA H.264 Encoder MFT", "VEN_10DE"}};
  const std::string nvidia = "{\"name\":\"NVIDIA H.264 Encoder MFT\",\"vendor_id\":\"VEN_10DE\",\"vendor\":\"nvidia\"}";
  const std::string intel = "{\"name\":\"Intel\xC2\xAE Quick Sync Video H.264 Encoder MFT\",\"vendor_id\":\"VEN_8086\",\"vendor\":\"intel\"}";
  const std::string other = "{\"name\":\"Some SoC H264 Encoder\",\"vendor_id\":\"VEN_5143\",\"vendor\":\"unknown\"}";
  if (encoderCandidatesJson({}, EncoderVendor::Unknown) != "[]") fail("no hardware encoder is an empty list");
  if (encoderCandidatesJson(hybrid, EncoderVendor::Unknown) != "[" + nvidia + "," + intel + "," + other + "]") fail("candidates in try order");
  if (encoderCandidatesJson(hybrid, EncoderVendor::Intel) != "[" + intel + "," + nvidia + "," + other + "]") fail("preferred vendor first");
  // An encoder that names nothing still counts as a candidate.
  if (encoderCandidatesJson({{"", ""}, {"AMDh264Encoder", ""}}, EncoderVendor::Unknown) != "[{\"name\":\"AMDh264Encoder\",\"vendor\":\"amd\"},{}]")
    fail("anonymous candidate");

  std::cout << "encoder_info_json_test passed" << std::endl;
  return 0;
}
