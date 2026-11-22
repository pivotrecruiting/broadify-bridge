import {
  MeetingCameraSelectionSchema,
  MeetingEngineStartSchema,
  MeetingGraphicsConfigureOutputsSchema,
  MeetingRecordingPickPathSchema,
  MeetingRecordingStartSchema,
  MeetingRecordingToggleSchema,
  MeetingScreenPickSchema,
  MeetingScreenStartSchema,
} from "./meeting-command-schemas.js";
import { parseRelayPayload } from "../relay-command-schemas.js";

describe("MeetingEngineStartSchema", () => {
  it("accepts landscape, portrait and empty payloads", () => {
    expect(
      MeetingEngineStartSchema.parse({ width: 1920, height: 1080, fps: 30 }),
    ).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(
      MeetingEngineStartSchema.parse({ width: 1080, height: 1920, fps: 30 }),
    ).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(MeetingEngineStartSchema.parse({ width: 720, height: 1280 })).toEqual({
      width: 720,
      height: 1280,
    });
    expect(MeetingEngineStartSchema.parse({})).toEqual({});
  });

  it("keeps the size bounds and rejects unknown keys", () => {
    expect(() => MeetingEngineStartSchema.parse({ width: 159 })).toThrow();
    expect(() => MeetingEngineStartSchema.parse({ height: 4321 })).toThrow();
    expect(() =>
      MeetingEngineStartSchema.parse({ width: 1080, height: 1920, orientation: "portrait" }),
    ).toThrow();
  });
});

describe("MeetingGraphicsConfigureOutputsSchema", () => {
  it("accepts a portrait plane size", () => {
    expect(
      MeetingGraphicsConfigureOutputsSchema.parse({ width: 1080, height: 1920, fps: 30 }),
    ).toEqual({ width: 1080, height: 1920, fps: 30 });
  });
});

describe("MeetingCameraSelectionSchema", () => {
  const builderPayload = {
    camera_index: 1,
    stable_key: "device-symbolic-link",
    width: 1920,
    height: 1080,
    fps: 30,
    selection_source: "user",
    lock_mode: "manual_index",
  };

  const parseCameraPayload = (command: string, payload: unknown) =>
    parseRelayPayload(
      MeetingCameraSelectionSchema,
      payload,
      `Invalid payload for ${command}`,
    );

  it("accepts camera_index and stable_key selections", () => {
    expect(
      MeetingCameraSelectionSchema.parse({ camera_index: 1 }),
    ).toEqual({ camera_index: 1 });
    expect(
      MeetingCameraSelectionSchema.parse({ stable_key: "device-symbolic-link" }),
    ).toEqual({ stable_key: "device-symbolic-link" });
    expect(
      MeetingCameraSelectionSchema.parse({
        camera_index: 2,
        stable_key: "stable-wins-in-helper",
      }),
    ).toEqual({ camera_index: 2, stable_key: "stable-wins-in-helper" });
  });

  it("accepts real webapp builder payloads through the relay parse path", () => {
    expect(
      parseCameraPayload("meeting_camera_select", builderPayload),
    ).toEqual(builderPayload);
    expect(
      parseCameraPayload("meeting_camera_start", builderPayload),
    ).toEqual(builderPayload);
  });

  it("accepts the connections-page payload through the relay parse path", () => {
    expect(
      parseCameraPayload("meeting_camera_select", { camera_index: 2 }),
    ).toEqual({ camera_index: 2 });
    expect(
      parseCameraPayload("meeting_camera_start", { camera_index: 2 }),
    ).toEqual({ camera_index: 2 });
  });

  it("passes through future additive webapp fields", () => {
    expect(
      MeetingCameraSelectionSchema.parse({
        camera_index: 2,
        future_field: "kept",
      }),
    ).toEqual({ camera_index: 2, future_field: "kept" });
  });

  it("rejects invalid camera selection fields", () => {
    expect(() =>
      parseCameraPayload("meeting_camera_select", { camera_index: -1 }),
    ).toThrow("Invalid payload for meeting_camera_select");
    expect(() =>
      parseCameraPayload("meeting_camera_start", { camera_index: -1 }),
    ).toThrow("Invalid payload for meeting_camera_start");
    expect(() =>
      MeetingCameraSelectionSchema.parse({ stable_key: "" }),
    ).toThrow();
  });
});

describe("MeetingScreenStartSchema", () => {
  it("accepts source_id and optional include_cursor", () => {
    expect(MeetingScreenStartSchema.parse({ source_id: "display:1" })).toEqual({
      source_id: "display:1",
    });
    expect(
      MeetingScreenStartSchema.parse({
        source_id: "window:42",
        include_cursor: true,
      }),
    ).toEqual({ source_id: "window:42", include_cursor: true });
  });

  it("strips unknown keys", () => {
    expect(
      MeetingScreenStartSchema.parse({
        source_id: "display:1",
        include_cursor: false,
        future_field: "strip-me",
      }),
    ).toEqual({ source_id: "display:1", include_cursor: false });
  });

  it("rejects empty and overlong source ids", () => {
    expect(() => MeetingScreenStartSchema.parse({ source_id: "" })).toThrow();
    expect(() =>
      MeetingScreenStartSchema.parse({ source_id: "x".repeat(257) }),
    ).toThrow();
  });

  it("rejects non-boolean include_cursor", () => {
    expect(() =>
      MeetingScreenStartSchema.parse({
        source_id: "display:1",
        include_cursor: "yes",
      }),
    ).toThrow();
  });
});

describe("MeetingScreenPickSchema", () => {
  it("accepts an empty payload", () => {
    expect(MeetingScreenPickSchema.parse({})).toEqual({});
  });

  it("strips unknown keys", () => {
    expect(
      MeetingScreenPickSchema.parse({
        include_cursor: true,
        future_field: "strip-me",
      }),
    ).toEqual({ include_cursor: true });
  });
});

describe("MeetingRecordingStartSchema", () => {
  it("accepts a start without codec as before: an absolute .mp4 path", () => {
    expect(
      MeetingRecordingStartSchema.parse({
        file_path: "/Users/x/Movies/rec.mp4",
        mic_device_id: "m1",
      }),
    ).toEqual({ file_path: "/Users/x/Movies/rec.mp4", mic_device_id: "m1" });
    expect(
      MeetingRecordingStartSchema.safeParse({ file_path: "C:\\rec\\a.MP4" }).success,
    ).toBe(true);
  });

  it.each([
    ["h264", "/Users/x/rec.mp4"],
    ["hevc", "/Users/x/rec.mp4"],
    ["prores_422_lt", "/Users/x/rec.mov"],
    ["prores_422", "/Users/x/rec.mov"],
    ["prores_422_hq", "C:\\rec\\a.mov"],
  ])("accepts %s with the extension of its container", (codec, filePath) => {
    expect(
      MeetingRecordingStartSchema.parse({ file_path: filePath, codec }),
    ).toEqual({ file_path: filePath, codec });
  });

  it.each([
    ["hevc", "/Users/x/rec.mov"],
    ["prores_422", "/Users/x/rec.mp4"],
    [undefined, "/Users/x/rec.mov"],
  ])("rejects %s with the extension of another container", (codec, filePath) => {
    const parsed = MeetingRecordingStartSchema.safeParse({
      file_path: filePath,
      ...(codec ? { codec } : {}),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["file_path"]);
  });

  it("keeps the path guard for every codec", () => {
    for (const filePath of [
      "relative.mov",
      "/Users/x/../../etc/hosts.mov",
      "/Users/x/rec.mov\0",
      "/Users/x/.zshrc",
    ]) {
      expect(
        MeetingRecordingStartSchema.safeParse({
          file_path: filePath,
          codec: "prores_422",
        }).success,
      ).toBe(false);
    }
  });

  it("lets a codec name outside the contract through for the handler to refuse", () => {
    // The handler answers meeting_recording_codec_unsupported; the path still
    // has to be a safe recording path of some container.
    for (const filePath of ["/Users/x/rec.mp4", "/Users/x/rec.mov"]) {
      expect(
        MeetingRecordingStartSchema.parse({ file_path: filePath, codec: "av1" }),
      ).toEqual({ file_path: filePath, codec: "av1" });
    }
    for (const filePath of ["/Users/x/.zshrc", "/Users/x/../rec.mp4", "rec.mov"]) {
      expect(
        MeetingRecordingStartSchema.safeParse({ file_path: filePath, codec: "av1" })
          .success,
      ).toBe(false);
    }
  });

  it("rejects a codec that is not a name and unknown keys", () => {
    for (const codec of [5, "", null, "x".repeat(65)]) {
      expect(
        MeetingRecordingStartSchema.safeParse({
          file_path: "/Users/x/rec.mp4",
          codec,
        }).success,
      ).toBe(false);
    }
    expect(
      MeetingRecordingStartSchema.safeParse({
        file_path: "/Users/x/rec.mp4",
        upload_copy: true,
      }).success,
    ).toBe(false);
  });
});

describe("MeetingRecordingPickPathSchema / MeetingRecordingToggleSchema", () => {
  it("accept an empty payload (Stream Deck key, older web app)", () => {
    expect(MeetingRecordingPickPathSchema.parse({})).toEqual({});
    expect(MeetingRecordingToggleSchema.parse({})).toEqual({});
  });

  it("pass the codec through and drop unknown keys", () => {
    expect(
      MeetingRecordingPickPathSchema.parse({
        default_name: "take.mov",
        locale: "en",
        codec: "prores_422",
        extra: 1,
      }),
    ).toEqual({ default_name: "take.mov", locale: "en", codec: "prores_422" });
    expect(
      MeetingRecordingToggleSchema.parse({ mic_device_id: "m1", codec: "hevc", extra: 1 }),
    ).toEqual({ mic_device_id: "m1", codec: "hevc" });
  });

  it("stay lenient on the fields that existed before the codec", () => {
    expect(
      MeetingRecordingPickPathSchema.parse({ default_name: 5, locale: null }),
    ).toEqual({});
    expect(MeetingRecordingToggleSchema.parse({ mic_device_id: 5 })).toEqual({});
  });

  it("let a codec name outside the contract through, reject a non-name", () => {
    expect(MeetingRecordingPickPathSchema.parse({ codec: "av1" })).toEqual({ codec: "av1" });
    expect(MeetingRecordingToggleSchema.parse({ codec: "av1" })).toEqual({ codec: "av1" });
    expect(MeetingRecordingPickPathSchema.safeParse({ codec: 5 }).success).toBe(false);
    expect(MeetingRecordingToggleSchema.safeParse({ codec: "" }).success).toBe(false);
  });
});
