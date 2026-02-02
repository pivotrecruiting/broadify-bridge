import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import {
  GRAPHICS_OUTPUT_CONFIG_VERSION,
  GraphicsConfigureOutputsSchema,
} from "./graphics-schemas.js";
import { atomicWriteJson, ensureDir } from "./file-utils.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";

const OUTPUT_CONFIG_FILE = "graphics-output.json";

/**
 * Persisted output configuration store.
 */
export class OutputConfigStore {
  private config: GraphicsOutputConfigT | null = null;
  private filePath: string | null = null;

  /**
   * Initialize the store and load config from disk.
   *
   * @returns Promise resolved when config is loaded.
   */
  async initialize(): Promise<void> {
    const { userDataDir } = getBridgeContext();
    const graphicsDir = path.join(userDataDir, "graphics");
    await ensureDir(graphicsDir);

    this.filePath = path.join(graphicsDir, OUTPUT_CONFIG_FILE);
    await this.loadFromDisk();
  }

  /**
   * Get current output config.
   *
   * @returns Output config or null if not configured.
   */
  getConfig(): GraphicsOutputConfigT | null {
    return this.config;
  }

  /**
   * Persist and set output config.
   *
   * @param config Output configuration payload.
   * @returns Promise resolved when config is written.
   */
  async setConfig(config: GraphicsOutputConfigT): Promise<void> {
    if (!this.filePath) {
      await this.initialize();
    }

    const { config: normalized } = this.normalizeConfig(config);
    this.config = normalized;
    await atomicWriteJson(this.filePath as string, normalized);
  }

  /**
   * Clear output config on disk.
   *
   * @returns Promise resolved when config file is removed.
   */
  async clear(): Promise<void> {
    if (!this.filePath) {
      await this.initialize();
    }

    this.config = null;
    try {
      await fs.unlink(this.filePath as string);
    } catch {
      // Ignore if file does not exist.
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.filePath) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const result = this.parseConfig(parsed);
      this.config = result.config;
      if (result.deleteFile) {
        await this.deleteConfigFile();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Failed to load output config: ${message}`
      );
      await this.deleteConfigFile();
      this.config = null;
    }
  }

  private parseConfig(data: unknown): {
    config: GraphicsOutputConfigT | null;
    deleteFile: boolean;
  } {
    const logger = getBridgeContext().logger;
    if (!data || typeof data !== "object") {
      logger.warn("[Graphics] Output config invalid (not an object); deleting");
      return { config: null, deleteFile: true };
    }

    const raw = data as Record<string, unknown>;
    const version = raw.version;
    if (typeof version !== "number" || !Number.isFinite(version)) {
      logger.warn("[Graphics] Output config missing version; deleting");
      return { config: null, deleteFile: true };
    }
    if (version !== GRAPHICS_OUTPUT_CONFIG_VERSION) {
      logger.warn(
        `[Graphics] Output config version ${version} does not match supported (${GRAPHICS_OUTPUT_CONFIG_VERSION}). Deleting.`
      );
      return { config: null, deleteFile: true };
    }

    const strictResult = GraphicsConfigureOutputsSchema.safeParse(data);
    if (!strictResult.success) {
      logger.warn("[Graphics] Output config schema invalid; deleting");
      return { config: null, deleteFile: true };
    }

    const normalized = this.normalizeConfig(strictResult.data);
    return { config: normalized.config, deleteFile: false };
  }

  private normalizeConfig(
    config: GraphicsOutputConfigT
  ): { config: GraphicsOutputConfigT; migrated: boolean } {
    const migrated = config.version !== GRAPHICS_OUTPUT_CONFIG_VERSION;
    return {
      config: {
        ...config,
        version: GRAPHICS_OUTPUT_CONFIG_VERSION,
      },
      migrated,
    };
  }

  private async deleteConfigFile(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    try {
      await fs.unlink(this.filePath);
    } catch {
      // Ignore if file does not exist.
    }
  }
}

export const outputConfigStore = new OutputConfigStore();
