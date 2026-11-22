#include "recorder/recording_probe.h"

namespace broadify::meeting {

// No recorder backend on this platform (meeting_recorder_stub.cpp): the
// enumeration succeeds and finds nothing.
RecordingProbeResult probeRecordingEncoders() {
  RecordingProbeResult result;
  result.ok = true;
  return result;
}

}  // namespace broadify::meeting
