#pragma once

#include "recorder/recording_codec.h"

#include <string>
#include <vector>

namespace broadify::meeting {

// Hardware video encoders of this machine for the meeting recorder, reported
// by `meeting-helper --probe-recording` (ADR-0010). The bridge runs the probe
// once and derives `get_status.capabilities.meeting.recording` from it.
//
// Hardware only, like the encoders of the program stream and the PGM
// recording (ADR-0002/0006/0009): a software encoder is never listed, so a
// codec without a hardware encoder is not offered instead of silently falling
// back to the CPU.

struct RecordingEncoderInfo {
  RecordingCodec codec = RecordingCodec::H264;
  // Product name the platform reports for the encoder.
  std::string name;
  // "nvidia" | "amd" | "intel" | "unknown" on Windows (the rule the program
  // stream ranks its encoders with); empty on macOS, where VideoToolbox has
  // no vendor notion.
  std::string vendor;
};

struct RecordingProbeResult {
  // "videotoolbox" | "mediafoundation" | "none" (no recorder backend).
  std::string backend = "none";
  // False when the platform enumeration itself failed: the encoder list is
  // then unknown, which is not the same as "no hardware encoder". Where the
  // platform enumerates per codec (Windows), one codec's failure only leaves
  // that codec out; false means that no enumeration worked.
  bool ok = false;
  // One entry per enumerated hardware encoder, in the platform's order of
  // preference; a codec can appear more than once (two GPUs on Windows).
  std::vector<RecordingEncoderInfo> encoders;
};

// The probe line: one single-line JSON object,
//   {"type":"recording_probe","backend":"...","ok":true,
//    "encoders":[{"codec":"h264","name":"...","vendor":"..."}]}
// with "vendor" only where the platform reports one.
std::string recordingProbeJson(const RecordingProbeResult &result);

// Whether the enumeration found a hardware encoder for the codec.
bool recordingProbeHasEncoder(const RecordingProbeResult &result,
                              RecordingCodec codec);

// Platform enumeration (VideoToolbox, Media Foundation, or the empty result of
// a platform without a recorder backend). Enumeration only: no encoder session
// is created and no device is opened.
RecordingProbeResult probeRecordingEncoders();

}  // namespace broadify::meeting
