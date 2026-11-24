#pragma once

#include "recorder/meeting_recorder.h"

#include <optional>
#include <string>

namespace broadify::meeting {

// The claim of a recording start against the recorder's state, shared by the
// platform recorders so it is unit-testable without a device. Called under
// the recorder mutex. Returns the outcome that ends the start, or nullopt
// when the start is claimed (`starting` set) and the caller builds the
// pipeline.
//
// While a recording is running or starting the start is refused and NOTHING
// is written: the last error and the disk-space numbers are the state of
// that recording, and recording.status must keep reporting them unchanged
// (a refused second start once left "already_recording" on a recording that
// then finished cleanly).
inline std::optional<RecordingStartOutcome> claimRecordingStart(
    bool active, bool &starting, std::string &lastError,
    std::optional<RecordingDiskSpace> &diskSpaceLow, bool validArguments) {
  if (active || starting) {
    return RecordingStartOutcome::AlreadyRecording;
  }
  diskSpaceLow.reset();
  if (!validArguments) {
    lastError = "invalid_arguments";
    return RecordingStartOutcome::Failed;
  }
  starting = true;
  return std::nullopt;
}

}  // namespace broadify::meeting
