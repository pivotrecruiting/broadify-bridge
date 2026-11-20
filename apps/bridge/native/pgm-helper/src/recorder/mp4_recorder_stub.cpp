// Mp4Recorder for platforms without a recording backend (Windows until its
// own unit, ADR-0009): nothing is ever written. The engine checks
// Mp4Recorder::supported() first and answers `recording_unsupported`.
#include "recorder/mp4_recorder.h"

namespace broadify::pgm {

bool Mp4Recorder::supported() { return false; }

Mp4Recorder::Mp4Recorder() : impl_(nullptr) {}

Mp4Recorder::~Mp4Recorder() = default;

bool Mp4Recorder::start(const std::string &, bool, std::string &error) {
  error = "Recording the program is not supported on this platform yet.";
  return false;
}

bool Mp4Recorder::stop(std::string &) { return true; }

bool Mp4Recorder::isActive() const { return false; }

RecordingStatus Mp4Recorder::status() const { return RecordingStatus{}; }

void Mp4Recorder::appendVideo(const EncodedAccessUnit &) {}

void Mp4Recorder::appendAudio(const AudioChunk &) {}

}  // namespace broadify::pgm
