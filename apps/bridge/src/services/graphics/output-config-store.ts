import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { GraphicsConfigureOutputsSchema } from "./graphics-schemas.js";
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

    this.config = config;
    await atomicWriteJson(this.filePath as string, config);
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
      this.config = GraphicsConfigureOutputsSchema.parse(parsed);
    } catch {
      this.config = null;
    }
  }
}

export const outputConfigStore = new OutputConfigStore();
