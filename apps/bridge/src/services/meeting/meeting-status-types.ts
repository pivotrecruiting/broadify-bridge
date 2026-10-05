import type { MeetingHelperManagerStatusT } from "./meeting-helper-manager.js";

export type MeetingContentGeometryT = {
  mode: "pip" | "fullscreen";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  rotation_x: number;
  rotation_y: number;
};

export type MeetingContentVideoSourceT = MeetingContentGeometryT & {
  asset_id: string;
  muted: boolean;
  loop: boolean;
  updated_at: number;
};

export type MeetingBrowserSourceT = MeetingContentGeometryT & {
  url: string;
  updated_at: number;
};

export type MeetingContentSourceT = {
  video: MeetingContentVideoSourceT | null;
  browser: MeetingBrowserSourceT | null;
};

type MeetingProgramGeometryFieldsT = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  rotation_x?: number;
  rotation_y?: number;
};

export type MeetingProgramSummaryT = {
  media_layer?: Record<string, unknown> &
    MeetingProgramGeometryFieldsT & {
      enabled?: boolean;
      mode?: string;
      page?: number;
      page_count?: number;
      asset_id?: string | null;
      render_status?: string | null;
      source?: "page" | "screen" | string;
      template_id?: string | null;
    };
  camera_render?: Record<string, unknown> & {
    enabled?: boolean;
    mirror?: boolean;
  };
  speaker_layout?: Record<string, unknown> & {
    enabled?: boolean;
    layout?: string;
    scale?: number;
  };
  cornerbug?: Record<string, unknown> &
    Pick<MeetingProgramGeometryFieldsT, "x" | "y"> & {
      enabled?: boolean;
      has_image?: boolean;
      size?: number;
      logo_asset_id?: string | null;
    };
  graphics?: Record<string, unknown> & {
    enabled?: boolean;
    graphic_id?: string | null;
    template?: string | null;
    template_id?: string | null;
    source?: string | null;
    handoff_target?: string | null;
  };
};

export type MeetingKeyerSettingsT = Record<string, unknown> & {
  enabled?: boolean;
  background_asset_id?: string | null;
  background_template_id?: string | null;
  background_image_set?: boolean;
};

export type MeetingScreenCaptureCapabilitiesT = {
  supported: boolean;
  system_picker: boolean;
  enumeration: boolean;
  permission_status: string;
  unsupported_reason: string | null;
};

export type MeetingScreenCaptureStatusT = {
  running: boolean;
  picker_pending: boolean;
  source_id: string | null;
  kind: string | null;
  title: string | null;
  app_name: string | null;
  width: number | null;
  height: number | null;
  captured_frames: number;
  last_error: string | null;
  last_error_at: number | null;
  capabilities: MeetingScreenCaptureCapabilitiesT;
};

export type MeetingStatusT = {
  platform?: NodeJS.Platform;
  manager: MeetingHelperManagerStatusT;
  engine:
    | (Record<string, unknown> & {
        program?: MeetingProgramSummaryT;
        program_revision?: number;
        camera_permission_status?: string;
        screen_capture?: MeetingScreenCaptureStatusT;
      })
    | null;
  engineError?: string;
  framebus?: Record<string, unknown>;
  keyer?: {
    settings: MeetingKeyerSettingsT;
    status: Record<string, unknown>;
  } | null;
  recording: Record<string, unknown> | null;
  virtualCamera?: Record<string, unknown>;
  call: { active: boolean; call_id: string | null };
  content_source: MeetingContentSourceT;
  camera_permission_status: string | null;
};

export type MeetingStatusEventT = {
  reason: string;
  at: number;
  status: MeetingStatusT;
};
