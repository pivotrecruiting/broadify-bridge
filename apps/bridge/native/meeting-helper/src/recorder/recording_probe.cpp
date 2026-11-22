#include "recorder/recording_probe.h"

#include "util/json_utils.h"

#include <algorithm>

namespace broadify::meeting {

bool recordingProbeHasEncoder(const RecordingProbeResult &result,
                              RecordingCodec codec) {
  return std::any_of(result.encoders.begin(), result.encoders.end(),
                     [codec](const RecordingEncoderInfo &encoder) {
                       return encoder.codec == codec;
                     });
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
