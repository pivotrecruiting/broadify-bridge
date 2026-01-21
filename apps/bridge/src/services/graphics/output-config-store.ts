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
   */
  getConfig(): GraphicsOutputConfigT | null {
    return this.config;
  }

  /**
   * Persist and set output config.
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
      if (result.config && result.migrated) {
        await atomicWriteJson(this.filePath, result.config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Failed to load output config: ${message}`
      );
      this.config = null;
    }
  }

  private parseConfig(data: unknown): {
    config: GraphicsOutputConfigT | null;
    migrated: boolean;
  } {
    const logger = getBridgeContext().logger;
    const strictResult = GraphicsConfigureOutputsSchema.safeParse(data);
    if (strictResult.success) {
      const config = strictResult.data;
      if (config.version > GRAPHICS_OUTPUT_CONFIG_VERSION) {
        logger.warn(
          `[Graphics] Output config version ${config.version} is newer than supported (${GRAPHICS_OUTPUT_CONFIG_VERSION}). Ignoring.`
        );
        return { config: null, migrated: false };
      }
      const normalized = this.normalizeConfig(config);
      if (normalized.migrated) {
        logger.info(
          `[Graphics] Migrated output config to version ${GRAPHICS_OUTPUT_CONFIG_VERSION}`
        );
      }
      return normalized;
    }

    const legacy = this.coerceLegacyConfig(data);
    if (legacy) {
      const normalized = this.normalizeConfig(legacy);
      logger.warn("[Graphics] Migrated legacy output config with defaults");
      return { ...normalized, migrated: true };
    }

    logger.warn("[Graphics] Output config is invalid; ignoring");
    return { config: null, migrated: false };
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

  private coerceLegacyConfig(data: unknown): GraphicsOutputConfigT | null {
    if (!data || typeof data !== "object") {
      return null;
    }
    const candidate = data as Record<string, unknown>;
    const sanitized = {
      version: GRAPHICS_OUTPUT_CONFIG_VERSION,
      outputKey: candidate.outputKey,
      targets: candidate.targets,
      format: candidate.format,
      range: candidate.range,
      colorspace: candidate.colorspace,
    };
    const result = GraphicsConfigureOutputsSchema.safeParse(sanitized);
    return result.success ? result.data : null;
  }
}

export const outputConfigStore = new OutputConfigStore();
