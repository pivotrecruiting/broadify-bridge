import {
  MeetingCameraSelectionSchema,
  MeetingScreenPickSchema,
  MeetingScreenStartSchema,
} from "./meeting-command-schemas.js";
import { parseRelayPayload } from "../relay-command-schemas.js";

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
