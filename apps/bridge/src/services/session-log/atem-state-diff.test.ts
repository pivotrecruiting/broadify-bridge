import { diffAtemState, type AtemStateLikeT } from "./atem-state-diff.js";

const base: AtemStateLikeT = {
  video: {
    mixEffects: [{ programInput: 1, previewInput: 2, upstreamKeyers: [{ onAir: false }] }],
    downstreamKeyers: [{ onAir: false }],
  },
  recording: { status: { state: 0 } },
  inputs: { 1: { longName: "Cam 1" }, 2: { longName: "Cam 2" } },
};

describe("diffAtemState", () => {
  test("first state reports program/preview and only on-air keyers", () => {
    const events = diffAtemState(undefined, base);
    expect(events.map((e) => e.type)).toEqual(["program_changed", "preview_changed"]);
    expect(events[0]).toMatchObject({ source: "atem", me: 0, input_id: "1", input_name: "Cam 1" });
  });

  test("unchanged state yields no events", () => {
    expect(diffAtemState(base, structuredClone(base))).toEqual([]);
  });

  test("cut, keyers and recording are detected", () => {
    const next: AtemStateLikeT = structuredClone(base);
    next.video!.mixEffects![0]!.programInput = 2;
    next.video!.downstreamKeyers![0]!.onAir = true;
    next.recording = { status: { state: 1 }, duration: { hours: 0, minutes: 1, seconds: 2, frames: 3 } };
    const events = diffAtemState(base, next);
    expect(events.map((e) => e.type)).toEqual(["program_changed", "keyer_on_air", "recording_started"]);
    expect(events.find((e) => e.type === "keyer_on_air")).toMatchObject({ keyer: "dsk1" });
    expect(events.find((e) => e.type === "recording_started")).toMatchObject({ timecode: "00:01:02:03" });
  });
});
