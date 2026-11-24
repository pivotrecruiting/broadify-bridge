#pragma once

#include "helper_common/recording_encode_policy.h"

#include <array>
#include <cstddef>
#include <optional>
#include <string_view>

namespace broadify::meeting {

using broadify::helper::RecordingCodec;

enum class RecordingContainer { Mp4, Mov };
enum class RecordingAudioCodec { Aac, Pcm };

// What a recording of one codec is written as. The native source of truth for
// codec -> container and audio; the bridge holds the same table in
// services/meeting/meeting-recording-codecs.ts, and its test compares the two
// row by row.
struct RecordingCodecFormat {
  RecordingCodec codec;
  // Value of `MeetingRecordingCodecT` (packages/protocol).
  const char *name;
  RecordingContainer container;
  RecordingAudioCodec audio;
};

// Indexed by the enum value (recording_codec_test pins the order).
inline constexpr std::array<RecordingCodecFormat, 5> kRecordingCodecFormats = {{
    {RecordingCodec::H264, "h264", RecordingContainer::Mp4,
     RecordingAudioCodec::Aac},
    {RecordingCodec::Hevc, "hevc", RecordingContainer::Mp4,
     RecordingAudioCodec::Aac},
    {RecordingCodec::ProRes422Lt, "prores_422_lt", RecordingContainer::Mov,
     RecordingAudioCodec::Pcm},
    {RecordingCodec::ProRes422, "prores_422", RecordingContainer::Mov,
     RecordingAudioCodec::Pcm},
    {RecordingCodec::ProRes422Hq, "prores_422_hq", RecordingContainer::Mov,
     RecordingAudioCodec::Pcm},
}};

inline const RecordingCodecFormat &recordingCodecFormat(RecordingCodec codec) {
  return kRecordingCodecFormats[static_cast<size_t>(codec)];
}

// Value of `MeetingRecordingContainerT`; also the file extension.
inline const char *recordingContainerName(RecordingContainer container) {
  return container == RecordingContainer::Mov ? "mov" : "mp4";
}

inline const char *recordingCodecName(RecordingCodec codec) {
  return recordingCodecFormat(codec).name;
}

inline std::optional<RecordingCodec> recordingCodecFromName(
    std::string_view name) {
  for (const RecordingCodecFormat &format : kRecordingCodecFormats) {
    if (name == format.name) {
      return format.codec;
    }
  }
  return std::nullopt;
}

}  // namespace broadify::meeting
