#include "recorder/meeting_recorder.h"

// Non-Apple stub. Recording is currently implemented only on macOS
// (AVAssetWriter); other platforms link this no-op so the shared control/
// pipeline code compiles and runs without recording support.

namespace broadify::meeting {

struct MeetingRecorder::Impl {};

MeetingRecorder::MeetingRecorder() : impl_(new Impl()) {}
MeetingRecorder::~MeetingRecorder() { delete impl_; }

std::vector<MicrophoneInfo> MeetingRecorder::listMicrophones() const {
  return {};
}

bool MeetingRecorder::start(const std::string &, const std::string &, uint32_t,
                            uint32_t, uint32_t) {
  return false;
}

void MeetingRecorder::appendVideoFrame(const uint8_t *, uint32_t, uint32_t) {}

void MeetingRecorder::stop() {}

RecordingStatus MeetingRecorder::status() const { return RecordingStatus{}; }

}  // namespace broadify::meeting
