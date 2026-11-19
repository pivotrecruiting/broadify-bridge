import { MeetingContentSourceState } from "./meeting-content-source-state.js";
import {
  MEETING_BROWSER_SOURCE_LAYER_ID,
  MEETING_CONTENT_VIDEO_LAYER_ID,
} from "./meeting-content-layers.js";

describe("MeetingContentSourceState", () => {
  it("keeps video and browser slots independent", () => {
    const state = new MeetingContentSourceState();

    state.setVideo(
      {
        asset_id: "asset-1",
        muted: true,
        loop: false,
        mode: "pip",
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        rotation: 5,
        rotation_x: 6,
        rotation_y: 7,
      },
      100,
    );
    state.setBrowser(
      "https://example.test/source",
      {
        url: "https://example.test/source",
        mode: "fullscreen",
        x: 0.6,
        y: 0.6,
        width: 0.35,
        height: 0.35,
        rotation: 0,
        rotation_x: 0,
        rotation_y: 0,
      },
      200,
    );

    expect(state.snapshot()).toEqual({
      video: expect.objectContaining({ asset_id: "asset-1", updated_at: 100 }),
      browser: expect.objectContaining({
        url: "https://example.test/source",
        updated_at: 200,
      }),
    });

    state.clearVideo();

    expect(state.snapshot()).toEqual({
      video: null,
      browser: expect.objectContaining({ url: "https://example.test/source" }),
    });
  });

  it("drops a slot when the layer presence probe reports it missing", () => {
    const state = new MeetingContentSourceState();
    state.setVideo(
      {
        asset_id: "asset-1",
        muted: false,
        loop: true,
        mode: "pip",
        x: 0.6,
        y: 0.6,
        width: 0.35,
        height: 0.35,
        rotation: 0,
        rotation_x: 0,
        rotation_y: 0,
      },
      100,
    );
    state.setBrowser(
      "https://example.test/source",
      {
        url: "https://example.test/source",
        mode: "pip",
        x: 0.6,
        y: 0.6,
        width: 0.35,
        height: 0.35,
        rotation: 0,
        rotation_x: 0,
        rotation_y: 0,
      },
      200,
    );
    state.setLayerPresenceProbe(
      (layerId) => layerId === MEETING_BROWSER_SOURCE_LAYER_ID,
    );

    expect(state.snapshot()).toEqual({
      video: null,
      browser: expect.objectContaining({ url: "https://example.test/source" }),
    });
    expect(
      state.snapshot().video,
    ).toBeNull();
  });

  it("injects updated_at timestamps and applies placement defaults", () => {
    const state = new MeetingContentSourceState();
    state.setLayerPresenceProbe(
      (layerId) => layerId === MEETING_CONTENT_VIDEO_LAYER_ID,
    );

    state.setVideo({ asset_id: "asset-1", muted: false, loop: true }, 123);

    expect(state.snapshot().video).toEqual({
      asset_id: "asset-1",
      muted: false,
      loop: true,
      mode: "pip",
      x: 0.6,
      y: 0.6,
      width: 0.35,
      height: 0.35,
      rotation: 0,
      rotation_x: 0,
      rotation_y: 0,
      updated_at: 123,
    });
  });
});
