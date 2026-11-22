#include "recorder/recording_probe.h"

#include "util/json_utils.h"

namespace broadify::meeting {

const char *recordingCodecName(RecordingCodec codec) {
  switch (codec) {
    case RecordingCodec::H264:
      return "h264";
    case RecordingCodec::Hevc:
      return "hevc";
    case RecordingCodec::ProRes422Lt:
      return "prores_422_lt";
    case RecordingCodec::ProRes422:
      return "prores_422";
    case RecordingCodec::ProRes422Hq:
      return "prores_422_hq";
  }
  return "unknown";
}

std::string recordingProbeJson(const RecordingProbeResult &result) {
  std::string json = "{\"type\":\"recording_probe\",\"backend\":\"" +
                     jsonEscape(result.backend) + "\",\"ok\":" +
                     (result.ok ? "true" : "false") + ",\"encoders\":[";
  bool first = true;
  for (const RecordingEncoderInfo &encoder : result.encoders) {
    if (!first) {
      json += ",";
    }
    first = false;
    json += std::string("{\"codec\":\"") + recordingCodecName(encoder.codec) +
            "\",\"name\":\"" + jsonEscape(encoder.name) + "\"";
    if (!encoder.vendor.empty()) {
      json += ",\"vendor\":\"" + jsonEscape(encoder.vendor) + "\"";
    }
    json += "}";
  }
  json += "]}";
  return json;
}

}  // namespace broadify::meeting
