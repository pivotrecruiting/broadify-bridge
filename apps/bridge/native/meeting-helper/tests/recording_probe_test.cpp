// The --probe-recording line is parsed by the bridge
// (services/meeting/meeting-recording-probe.ts): its shape and the codec
// names are a contract, so they are pinned here without a platform backend.
#include "recorder/recording_probe.h"

#include <iostream>
#include <string>

using broadify::meeting::RecordingCodec;
using broadify::meeting::recordingCodecName;
using broadify::meeting::RecordingEncoderInfo;
using broadify::meeting::recordingProbeHasEncoder;
using broadify::meeting::recordingProbeJson;
using broadify::meeting::RecordingProbeResult;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recording_probe_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  // Codec names are the values of MeetingRecordingCodecT (packages/protocol).
  ok &= expect(std::string(recordingCodecName(RecordingCodec::H264)) == "h264",
               "h264 name");
  ok &= expect(std::string(recordingCodecName(RecordingCodec::Hevc)) == "hevc",
               "hevc name");
  ok &= expect(std::string(recordingCodecName(RecordingCodec::ProRes422Lt)) ==
                   "prores_422_lt",
               "prores 422 lt name");
  ok &= expect(std::string(recordingCodecName(RecordingCodec::ProRes422)) ==
                   "prores_422",
               "prores 422 name");
  ok &= expect(std::string(recordingCodecName(RecordingCodec::ProRes422Hq)) ==
                   "prores_422_hq",
               "prores 422 hq name");

  // A default result is a failed enumeration on a platform without backend.
  ok &= expect(recordingProbeJson(RecordingProbeResult{}) ==
                   R"({"type":"recording_probe","backend":"none","ok":false,"encoders":[]})",
               "default result serialises as failed and empty");

  // A successful enumeration that found no hardware encoder stays ok.
  {
    RecordingProbeResult result;
    result.backend = "mediafoundation";
    result.ok = true;
    ok &= expect(recordingProbeJson(result) ==
                     R"({"type":"recording_probe","backend":"mediafoundation","ok":true,"encoders":[]})",
                 "no hardware encoder is an empty list, not a failure");
  }

  // The vendor is written only where the platform reports one, and the
  // encoders keep their order.
  {
    RecordingProbeResult result;
    result.backend = "mediafoundation";
    result.ok = true;
    result.encoders.push_back(
        RecordingEncoderInfo{RecordingCodec::H264, "NVIDIA H.264 Encoder MFT", "nvidia"});
    result.encoders.push_back(
        RecordingEncoderInfo{RecordingCodec::Hevc, "Apple HEVC (HW)", ""});
    ok &= expect(
        recordingProbeJson(result) ==
            R"({"type":"recording_probe","backend":"mediafoundation","ok":true,"encoders":[)"
            R"({"codec":"h264","name":"NVIDIA H.264 Encoder MFT","vendor":"nvidia"},)"
            R"json({"codec":"hevc","name":"Apple HEVC (HW)"}]})json",
        "encoders serialise in order, vendor only when set");
    // The recorder's hardware gate: a codec counts only if it was enumerated.
    ok &= expect(recordingProbeHasEncoder(result, RecordingCodec::H264) &&
                     recordingProbeHasEncoder(result, RecordingCodec::Hevc),
                 "enumerated codecs have an encoder");
    ok &= expect(!recordingProbeHasEncoder(result, RecordingCodec::ProRes422),
                 "a codec that was not enumerated has none");
    ok &= expect(!recordingProbeHasEncoder(RecordingProbeResult{},
                                           RecordingCodec::H264),
                 "a failed enumeration has no encoder");
  }

  // Encoder names come from the driver: quotes, backslashes and line breaks
  // must not break the single-line JSON.
  {
    RecordingProbeResult result;
    result.backend = "videotoolbox";
    result.ok = true;
    result.encoders.push_back(
        RecordingEncoderInfo{RecordingCodec::ProRes422Hq, "Pro\"Res\\\nHQ", ""});
    const std::string json = recordingProbeJson(result);
    ok &= expect(json.find('\n') == std::string::npos,
                 "probe line stays a single line");
    ok &= expect(json.find(R"("name":"Pro\"Res\\\nHQ")") != std::string::npos,
                 "encoder name is escaped");
  }

  return ok ? 0 : 1;
}
