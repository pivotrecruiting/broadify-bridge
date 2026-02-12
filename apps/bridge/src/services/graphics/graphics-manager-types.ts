import type {
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsLayoutT,
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
