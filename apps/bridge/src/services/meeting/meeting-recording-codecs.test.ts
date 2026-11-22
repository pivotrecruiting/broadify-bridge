import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MEETING_RECORDING_CODEC,
  MEETING_RECORDING_CODECS,
  MEETING_RECORDING_CODEC_FORMATS,
  meetingRecordingContainer,
} from "./meeting-recording-codecs.js";
import { RECORDING_FILE_EXTENSIONS } from "../shared/recording-paths.js";

const NATIVE_CODEC_TABLE = join(
  __dirname,
  "../../../native/meeting-helper/src/recorder/recording_codec.h",
);

/**
 * Rows of `kRecordingCodecFormats`:
 * `{RecordingCodec::H264, "h264", RecordingContainer::Mp4, RecordingAudioCodec::Aac}`.
 */
function readNativeCodecFormats(): Array<{
  codec: string;
  container: string;
  audio: string;
}> {
  const header = readFileSync(NATIVE_CODEC_TABLE, "utf8");
  const rows = header.matchAll(
    /\{RecordingCodec::\w+,\s*"(\w+)",\s*RecordingContainer::(\w+),\s*RecordingAudioCodec::(\w+)\}/g,
  );
  return [...rows].map(([, codec, container, audio]) => ({
    codec,
    container: container.toLowerCase(),
    audio: audio.toLowerCase(),
  }));
}

describe("meeting-recording-codecs", () => {
  it("maps every codec to its container and audio", () => {
    expect(MEETING_RECORDING_CODEC_FORMATS).toEqual({
      h264: { container: "mp4", audio: "aac" },
      hevc: { container: "mp4", audio: "aac" },
      prores_422_lt: { container: "mov", audio: "pcm" },
      prores_422: { container: "mov", audio: "pcm" },
      prores_422_hq: { container: "mov", audio: "pcm" },
    });
    expect(MEETING_RECORDING_CODECS).toEqual([
      "h264",
      "hevc",
      "prores_422_lt",
      "prores_422",
      "prores_422_hq",
    ]);
  });

  it("records h264 in mp4 when no codec is requested", () => {
    expect(DEFAULT_MEETING_RECORDING_CODEC).toBe("h264");
    expect(meetingRecordingContainer()).toBe("mp4");
    expect(meetingRecordingContainer("hevc")).toBe("mp4");
    expect(meetingRecordingContainer("prores_422_hq")).toBe("mov");
  });

  it("uses only containers the recording paths know as file extensions", () => {
    for (const codec of MEETING_RECORDING_CODECS) {
      expect(RECORDING_FILE_EXTENSIONS).toContain(meetingRecordingContainer(codec));
    }
  });

  // The helper writes the file, the bridge names it: both tables must agree,
  // or a recording would be refused at the path guard or land in a container
  // its extension does not name.
  it("agrees with the codec table of the meeting helper, row by row", () => {
    const native = readNativeCodecFormats();
    expect(native).toHaveLength(MEETING_RECORDING_CODECS.length);
    expect(native).toEqual(
      MEETING_RECORDING_CODECS.map((codec) => ({
        codec,
        ...MEETING_RECORDING_CODEC_FORMATS[codec],
      })),
    );
  });
});
