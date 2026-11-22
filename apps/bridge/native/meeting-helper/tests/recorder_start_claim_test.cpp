#include "recorder/recorder_start_claim.h"

#include <iostream>
#include <optional>
#include <string>

using broadify::meeting::claimRecordingStart;
using broadify::meeting::RecordingDiskSpace;
using broadify::meeting::RecordingStartOutcome;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recorder_start_claim_test failed: " << what << std::endl;
  }
  return condition;
}

// The part of a recorder's state a start claim reads and writes.
struct RecorderState {
  bool active = false;
  bool starting = false;
  std::string lastError;
  std::optional<RecordingDiskSpace> diskSpaceLow;

  std::optional<RecordingStartOutcome> claim(bool validArguments = true) {
    return claimRecordingStart(active, starting, lastError, diskSpaceLow,
                               validArguments);
  }
};

}  // namespace

int main() {
  bool ok = true;

  {
    // An idle recorder is claimed; what the last recording left behind stays
    // until the start has built its pipeline or failed.
    RecorderState state;
    state.lastError = "finish_failed";
    ok &= expect(!state.claim().has_value(), "an idle recorder is claimed");
    ok &= expect(state.starting, "a claimed start is marked as starting");
    ok &= expect(!state.active, "a claimed start is not active yet");
  }

  {
    // A second start during a clean recording is refused and leaves no trace:
    // the recording reports no error, before and after it is finalized.
    RecorderState state;
    state.active = true;
    ok &= expect(state.claim() == RecordingStartOutcome::AlreadyRecording,
                 "a start during a recording is refused");
    ok &= expect(state.lastError.empty(),
                 "a refused start leaves the running recording without error");
    ok &= expect(!state.starting, "a refused start claims nothing");
  }

  {
    // The error of the running recording is its own (a writer failure the
    // status streams while it is active), not replaced by the refusal.
    RecorderState state;
    state.active = true;
    state.lastError = "writer_failed";
    ok &= expect(state.claim() == RecordingStartOutcome::AlreadyRecording,
                 "a start during a failing recording is refused");
    ok &= expect(state.lastError == "writer_failed",
                 "a refused start keeps the running recording's error");
  }

  {
    // A start racing the first one (pipeline still being built) is refused
    // the same way and does not release the first start's claim.
    RecorderState state;
    ok &= expect(!state.claim().has_value(), "the first start is claimed");
    state.diskSpaceLow = RecordingDiskSpace{2, 1};
    ok &= expect(state.claim() == RecordingStartOutcome::AlreadyRecording,
                 "a start during a start is refused");
    ok &= expect(state.starting, "the first start keeps its claim");
    ok &= expect(state.lastError.empty(), "a refused start writes no error");
    ok &= expect(state.diskSpaceLow.has_value(),
                 "a refused start keeps the disk-space numbers");
  }

  {
    // Invalid arguments fail an idle recorder's start with their token and
    // drop the disk-space numbers of an earlier refused start.
    RecorderState state;
    state.diskSpaceLow = RecordingDiskSpace{2, 1};
    ok &= expect(state.claim(false) == RecordingStartOutcome::Failed,
                 "invalid arguments fail the start");
    ok &= expect(state.lastError == "invalid_arguments",
                 "invalid arguments are the last error");
    ok &= expect(!state.starting, "a failed start claims nothing");
    ok &= expect(!state.diskSpaceLow.has_value(),
                 "a new start attempt drops the old disk-space numbers");
  }

  return ok ? 0 : 1;
}
