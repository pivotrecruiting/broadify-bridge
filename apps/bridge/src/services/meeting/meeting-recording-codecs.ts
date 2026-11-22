import type {
  MeetingRecordingCodecT,
  MeetingRecordingContainerT,
} from "@broadify/protocol";

/** Audio codec written next to the video of a meeting recording. */
export type MeetingRecordingAudioCodecT = "aac" | "pcm";

type MeetingRecordingCodecFormatT = {
  /** File container; its name is also the file extension. */
  container: MeetingRecordingContainerT;
  audio: MeetingRecordingAudioCodecT;
};

/**
 * What a meeting recording of one codec is written as (ADR-0010). The single
 * source on the bridge for codec -> container/extension/audio: the relay path
 * guard, the default recording path, the save panel and the capability block
 * all read it. The meeting helper holds the same table
 * (`kRecordingCodecFormats`, native/meeting-helper/src/recorder/recording_codec.h);
 * meeting-recording-codecs.test.ts compares the two.
 */
export const MEETING_RECORDING_CODEC_FORMATS = {
  h264: { container: "mp4", audio: "aac" },
  hevc: { container: "mp4", audio: "aac" },
  prores_422_lt: { container: "mov", audio: "pcm" },
  prores_422: { container: "mov", audio: "pcm" },
  prores_422_hq: { container: "mov", audio: "pcm" },
} as const satisfies Record<MeetingRecordingCodecT, MeetingRecordingCodecFormatT>;

/** Every codec of the recording contract, in the order of the table. */
export const MEETING_RECORDING_CODECS = Object.keys(
  MEETING_RECORDING_CODEC_FORMATS,
) as [MeetingRecordingCodecT, ...MeetingRecordingCodecT[]];

/**
 * Codec of a recording started without one: what the recorder wrote before
 * the format became selectable, and what older web apps and a Stream Deck key
 * without payload still get.
 */
export const DEFAULT_MEETING_RECORDING_CODEC: MeetingRecordingCodecT = "h264";

/** Container (and file extension) of a recording with the given codec. */
export function meetingRecordingContainer(
  codec: MeetingRecordingCodecT = DEFAULT_MEETING_RECORDING_CODEC,
): MeetingRecordingContainerT {
  return MEETING_RECORDING_CODEC_FORMATS[codec].container;
}
