import type {
  MeetingBrowserSourceSetPayloadT,
  MeetingContentVideoSetPayloadT,
} from "./meeting-command-schemas.js";
import {
  MEETING_BROWSER_SOURCE_LAYER_ID,
  MEETING_CONTENT_VIDEO_LAYER_ID,
} from "./meeting-content-layers.js";
import type {
  MeetingBrowserSourceT,
  MeetingContentGeometryT,
  MeetingContentSourceT,
  MeetingContentVideoSourceT,
} from "./meeting-status-types.js";

const DEFAULT_GEOMETRY: MeetingContentGeometryT = {
  mode: "pip",
  x: 0.6,
  y: 0.6,
  width: 0.35,
  height: 0.35,
  rotation: 0,
  rotation_x: 0,
  rotation_y: 0,
};

type VideoSetPayloadT = Partial<
  Omit<MeetingContentVideoSetPayloadT, "asset_id">
> & {
  asset_id: string;
};

type BrowserSetPayloadT = Partial<
  Omit<MeetingBrowserSourceSetPayloadT, "url">
> & {
  url?: string | null;
};

const geometryFromPayload = (
  payload: Partial<MeetingContentGeometryT>,
): MeetingContentGeometryT => ({
  mode: payload.mode ?? DEFAULT_GEOMETRY.mode,
  x: payload.x ?? DEFAULT_GEOMETRY.x,
  y: payload.y ?? DEFAULT_GEOMETRY.y,
  width: payload.width ?? DEFAULT_GEOMETRY.width,
  height: payload.height ?? DEFAULT_GEOMETRY.height,
  rotation: payload.rotation ?? DEFAULT_GEOMETRY.rotation,
  rotation_x: payload.rotation_x ?? DEFAULT_GEOMETRY.rotation_x,
  rotation_y: payload.rotation_y ?? DEFAULT_GEOMETRY.rotation_y,
});

export class MeetingContentSourceState {
  private video: MeetingContentVideoSourceT | null = null;
  private browser: MeetingBrowserSourceT | null = null;
  private layerPresenceProbe: ((layerId: string) => boolean) | null = null;

  setLayerPresenceProbe(probe: (layerId: string) => boolean): void {
    this.layerPresenceProbe = probe;
  }

  setVideo(payload: VideoSetPayloadT, now: number = Date.now()): void {
    this.video = {
      ...geometryFromPayload(payload),
      asset_id: payload.asset_id,
      muted: payload.muted ?? false,
      loop: payload.loop ?? true,
      updated_at: now,
    };
  }

  clearVideo(): void {
    this.video = null;
  }

  setBrowser(
    url: string,
    payload: BrowserSetPayloadT,
    now: number = Date.now(),
  ): void {
    this.browser = {
      ...geometryFromPayload(payload),
      url,
      updated_at: now,
    };
  }

  clearBrowser(): void {
    this.browser = null;
  }

  reset(): void {
    this.video = null;
    this.browser = null;
  }

  snapshot(): MeetingContentSourceT {
    if (
      this.video &&
      this.layerPresenceProbe &&
      !this.layerPresenceProbe(MEETING_CONTENT_VIDEO_LAYER_ID)
    ) {
      this.video = null;
    }
    if (
      this.browser &&
      this.layerPresenceProbe &&
      !this.layerPresenceProbe(MEETING_BROWSER_SOURCE_LAYER_ID)
    ) {
      this.browser = null;
    }
    return {
      video: this.video ? { ...this.video } : null,
      browser: this.browser ? { ...this.browser } : null,
    };
  }
}

export const meetingContentSourceState = new MeetingContentSourceState();
