import type {
  GraphicsFormatT,
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsLayoutT,
  GraphicsOutputConfigT,
  GraphicsSendPayloadT,
} from "./graphics-schemas.js";
import type { TemplateBindingsT } from "./template-bindings.js";

export type GraphicsLayerStateT = {
  layerId: string;
  category: GraphicsCategoryT;
  layout: GraphicsLayoutT;
  zIndex: number;
  backgroundMode: GraphicsBackgroundModeT;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
  schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  presetId?: string;
};

export type GraphicsActivePresetT = {
  presetId: string;
  durationMs: number | null;
  layerIds: Set<string>;
  pendingStart: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  timer: NodeJS.Timeout | null;
};

export type PreparedLayerT = GraphicsSendPayloadT & {
  backgroundMode: GraphicsBackgroundModeT;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
};

export type GraphicsStatusSnapshotT = {
  outputConfig: GraphicsOutputConfigT | null;
  browserInput: {
    mode: "browser_input";
    ready: boolean;
    stateStatus: "empty" | "ready" | "error";
    stateValid: boolean;
    browserInputUrl: string | null;
    browserInputWsUrl: string | null;
    recommendedInputName: string | null;
    transport: "websocket";
    browserClientCount: number;
    lastBrowserClientSeenAt: number | null;
    stateVersion: number;
    format: GraphicsFormatT | null;
    lastError: {
      code: "asset_missing" | "invalid_graphics_data" | "state_inconsistent";
      message: string;
      at: number;
    } | null;
  } | null;
  activePreset: {
    presetId: string;
    durationMs: number | null;
    startedAt: number | null;
    expiresAt: number | null;
    pendingStart: boolean;
    layerIds: string[];
    categories?: GraphicsCategoryT[];
  } | null;
  activePresets: Array<{
    presetId: string;
    durationMs: number | null;
    startedAt: number | null;
    expiresAt: number | null;
    pendingStart: boolean;
    layerIds: string[];
    categories?: GraphicsCategoryT[];
  }>;
};
