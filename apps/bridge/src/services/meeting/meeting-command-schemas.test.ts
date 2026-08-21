import { MeetingCameraSelectionSchema } from "./meeting-command-schemas.js";

describe("MeetingCameraSelectionSchema", () => {
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

  it("rejects invalid or unknown camera selection fields", () => {
    expect(() =>
      MeetingCameraSelectionSchema.parse({ camera_index: -1 }),
    ).toThrow();
    expect(() =>
      MeetingCameraSelectionSchema.parse({ stable_key: "" }),
    ).toThrow();
    expect(() =>
      MeetingCameraSelectionSchema.parse({ camera_id: "legacy" }),
    ).toThrow();
  });
});
