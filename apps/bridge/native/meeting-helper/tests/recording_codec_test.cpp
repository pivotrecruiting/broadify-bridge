// Codec table of the meeting recorder (recorder/recording_codec.h): the names
// are the values of MeetingRecordingCodecT / MeetingRecordingContainerT in
// packages/protocol and are parsed from recording.start, so they are pinned
// here. The bridge compares the table with its own in
// services/meeting/meeting-recording-codecs.test.ts.
#include "recorder/recording_codec.h"

#include <iostream>
#include <string>

using broadify::meeting::kRecordingCodecFormats;
using broadify::meeting::RecordingAudioCodec;
using broadify::meeting::RecordingCodec;
using broadify::meeting::recordingCodecFormat;
using broadify::meeting::recordingCodecFromName;
using broadify::meeting::recordingCodecName;
using broadify::meeting::RecordingContainer;
using broadify::meeting::recordingContainerName;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "recording_codec_test failed: " << what << std::endl;
  }
  return condition;
}

bool expectFormat(RecordingCodec codec, const std::string &name,
                  const std::string &container, RecordingAudioCodec audio) {
  const auto &format = recordingCodecFormat(codec);
  bool ok = expect(format.codec == codec, "row is indexed by its codec");
  ok &= expect(recordingCodecName(codec) == name, name.c_str());
  ok &= expect(recordingContainerName(format.container) == container,
               (name + " container").c_str());
  ok &= expect(format.audio == audio, (name + " audio").c_str());
  ok &= expect(recordingCodecFromName(name) == codec,
               (name + " parses back").c_str());
  return ok;
}

}  // namespace

int main() {
  bool ok = true;

  // recordingCodecFormat indexes the table by the enum value.
  for (size_t index = 0; index < kRecordingCodecFormats.size(); ++index) {
    ok &= expect(static_cast<size_t>(kRecordingCodecFormats[index].codec) ==
                     index,
                 "table order follows the enum");
  }

  ok &= expectFormat(RecordingCodec::H264, "h264", "mp4",
                     RecordingAudioCodec::Aac);
  ok &= expectFormat(RecordingCodec::Hevc, "hevc", "mp4",
                     RecordingAudioCodec::Aac);
  ok &= expectFormat(RecordingCodec::ProRes422Lt, "prores_422_lt", "mov",
                     RecordingAudioCodec::Pcm);
  ok &= expectFormat(RecordingCodec::ProRes422, "prores_422", "mov",
                     RecordingAudioCodec::Pcm);
  ok &= expectFormat(RecordingCodec::ProRes422Hq, "prores_422_hq", "mov",
                     RecordingAudioCodec::Pcm);

  ok &= expect(!recordingCodecFromName("av1"), "unknown name does not parse");
  ok &= expect(!recordingCodecFromName(""), "empty name does not parse");
  ok &= expect(!recordingCodecFromName("H264"), "names are case sensitive");

  return ok ? 0 : 1;
}
