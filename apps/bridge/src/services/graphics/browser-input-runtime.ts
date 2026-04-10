import { EventEmitter } from "node:events";
import { getBridgeContext } from "../bridge-context.js";
import type {
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsFormatT,
  GraphicsLayoutT,
  GraphicsOutputConfigT,
} from "./graphics-schemas.js";
import type { PreparedLayerT } from "./graphics-manager-types.js";
import type { TemplateBindingsT } from "./template-bindings.js";

const BROWSER_INPUT_ROUTE_PATH = "/graphics/browser-input";
const BROWSER_INPUT_WS_PATH = "/graphics/browser-input/ws";
const BROWSER_INPUT_ASSET_BASE_PATH = "/graphics/browser-input/assets";
const ASSET_URL_PATTERN = /asset:\/\/([a-zA-Z0-9_-]+)/g;

export type BrowserInputErrorCodeT =
  | "asset_missing"
  | "invalid_graphics_data"
  | "state_inconsistent";

export type BrowserInputErrorT = {
  code: BrowserInputErrorCodeT;
  message: string;
  at: number;
};

export type BrowserInputLayerSnapshotT = {
  layerId: string;
  category: GraphicsCategoryT;
  layout: GraphicsLayoutT;
  zIndex: number;
  backgroundMode: GraphicsBackgroundModeT;
  html: string;
  css: string;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
  presetId?: string;
};

export type BrowserInputStatusT = {
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
  lastError: BrowserInputErrorT | null;
};

export type BrowserInputStateSnapshotT = BrowserInputStatusT & {
  layers: BrowserInputLayerSnapshotT[];
};

const rewriteAssetUrls = (input: string): string => {
  return input.replace(
    ASSET_URL_PATTERN,
    (_match, assetId: string) =>
      `${BROWSER_INPUT_ASSET_BASE_PATH}/${encodeURIComponent(assetId)}`
  );
};

const buildBrowserInputUrl = (): string | null => {
  const { serverPort } = getBridgeContext();
  if (!serverPort) {
    return null;
  }
  return `http://127.0.0.1:${serverPort}${BROWSER_INPUT_ROUTE_PATH}`;
};

const buildBrowserInputWsUrl = (): string | null => {
  const { serverPort } = getBridgeContext();
  if (!serverPort) {
    return null;
  }
  return `ws://127.0.0.1:${serverPort}${BROWSER_INPUT_WS_PATH}`;
};

const buildRecommendedInputName = (): string | null => {
  const { bridgeName } = getBridgeContext();
  if (bridgeName && bridgeName.trim().length > 0) {
    return `Broadify ${bridgeName}`;
  }
  return "Broadify Browser Input";
};

/**
 * Bridge-side runtime projection for the vMix browser-input page.
 *
 * Keeps a lightweight snapshot of the currently active graphics layers and
 * exposes change notifications for HTTP/WS delivery to the browser page.
 */
export class BrowserInputRuntime extends EventEmitter {
  private outputConfig: GraphicsOutputConfigT | null = null;
  private layers = new Map<string, BrowserInputLayerSnapshotT>();
  private browserClientCount = 0;
  private lastBrowserClientSeenAt: number | null = null;
  private stateVersion = 0;
  private lastError: BrowserInputErrorT | null = null;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  configure(config: GraphicsOutputConfigT | null): void {
    this.outputConfig =
      config?.outputKey === "browser_input" ? config : null;
    this.layers.clear();
    this.browserClientCount = 0;
    this.lastBrowserClientSeenAt = null;
    this.lastError = null;
    this.bumpStateVersion();
  }

  clearLayers(): void {
    this.layers.clear();
    this.lastError = null;
    this.bumpStateVersion();
  }

  upsertLayer(prepared: PreparedLayerT): void {
    this.layers.set(prepared.layerId, {
      layerId: prepared.layerId,
      category: prepared.category,
      layout: prepared.layout,
      zIndex: prepared.zIndex,
      backgroundMode: prepared.backgroundMode,
      html: rewriteAssetUrls(prepared.bundle.html),
      css: rewriteAssetUrls(prepared.bundle.css ?? ""),
      values: { ...prepared.values },
      bindings: {
        cssVariables: { ...prepared.bindings.cssVariables },
        textContent: { ...prepared.bindings.textContent },
        textTypes: { ...prepared.bindings.textTypes },
        animationClass: prepared.bindings.animationClass,
      },
      presetId: prepared.presetId,
    });
    this.lastError = null;
    this.bumpStateVersion();
  }

  updateValues(
    layerId: string,
    values: Record<string, unknown>,
    bindings: TemplateBindingsT
  ): void {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    layer.values = { ...layer.values, ...values };
    layer.bindings = {
      cssVariables: { ...bindings.cssVariables },
      textContent: { ...bindings.textContent },
      textTypes: { ...bindings.textTypes },
      animationClass: bindings.animationClass,
    };
    this.lastError = null;
    this.bumpStateVersion();
  }

  updateLayout(layerId: string, layout: GraphicsLayoutT, zIndex?: number): void {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    layer.layout = layout;
    if (typeof zIndex === "number") {
      layer.zIndex = zIndex;
    }
    this.lastError = null;
    this.bumpStateVersion();
  }

  removeLayer(layerId: string): void {
    if (!this.layers.delete(layerId)) {
      return;
    }
    this.bumpStateVersion();
  }

  removePreset(presetId: string): void {
    let removed = false;
    for (const [layerId, layer] of this.layers.entries()) {
      if (layer.presetId === presetId) {
        this.layers.delete(layerId);
        removed = true;
      }
    }
    if (removed) {
      this.bumpStateVersion();
    }
  }

  markBrowserClientSeen(): void {
    this.lastBrowserClientSeenAt = Date.now();
    this.bumpStateVersion();
  }

  registerBrowserClient(): void {
    this.browserClientCount += 1;
    this.markBrowserClientSeen();
  }

  unregisterBrowserClient(): void {
    if (this.browserClientCount > 0) {
      this.browserClientCount -= 1;
      this.bumpStateVersion();
    }
  }

  reportError(code: BrowserInputErrorCodeT, message: string): void {
    this.lastError = {
      code,
      message,
      at: Date.now(),
    };
    this.bumpStateVersion();
  }

  getStatus(): BrowserInputStatusT | null {
    if (this.outputConfig?.outputKey !== "browser_input") {
      return null;
    }

    const stateStatus = this.lastError
      ? "error"
      : this.layers.size > 0
        ? "ready"
        : "empty";

    return {
      mode: "browser_input",
      ready: true,
      stateStatus,
      stateValid: this.lastError === null,
      browserInputUrl: buildBrowserInputUrl(),
      browserInputWsUrl: buildBrowserInputWsUrl(),
      recommendedInputName: buildRecommendedInputName(),
      transport: "websocket",
      browserClientCount: this.browserClientCount,
      lastBrowserClientSeenAt: this.lastBrowserClientSeenAt,
      stateVersion: this.stateVersion,
      format: this.outputConfig.format,
      lastError: this.lastError,
    };
  }

  getSnapshot(): BrowserInputStateSnapshotT {
    const status = this.getStatus();

    return {
      mode: "browser_input",
      ready: status?.ready ?? false,
      stateStatus: status?.stateStatus ?? "empty",
      stateValid: status?.stateValid ?? true,
      browserInputUrl: status?.browserInputUrl ?? null,
      browserInputWsUrl: status?.browserInputWsUrl ?? null,
      recommendedInputName: status?.recommendedInputName ?? null,
      transport: "websocket",
      browserClientCount: this.browserClientCount,
      lastBrowserClientSeenAt: this.lastBrowserClientSeenAt,
      stateVersion: this.stateVersion,
      format: status?.format ?? null,
      lastError: this.lastError,
      layers: Array.from(this.layers.values()).map((layer) => ({
        layerId: layer.layerId,
        category: layer.category,
        layout: { ...layer.layout },
        zIndex: layer.zIndex,
        backgroundMode: layer.backgroundMode,
        html: layer.html,
        css: layer.css,
        values: { ...layer.values },
        bindings: {
          cssVariables: { ...layer.bindings.cssVariables },
          textContent: { ...layer.bindings.textContent },
          textTypes: { ...layer.bindings.textTypes },
          animationClass: layer.bindings.animationClass,
        },
        presetId: layer.presetId,
      })),
    };
  }

  subscribe(listener: (snapshot: BrowserInputStateSnapshotT) => void): () => void {
    this.on("snapshot", listener);
    return () => {
      this.off("snapshot", listener);
    };
  }

  private bumpStateVersion(): void {
    this.stateVersion += 1;
    this.emit("snapshot", this.getSnapshot());
  }
}

export const browserInputRuntime = new BrowserInputRuntime();
