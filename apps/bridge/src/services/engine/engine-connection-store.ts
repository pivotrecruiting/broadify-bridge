import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import { atomicWriteJson, ensureDir } from "../graphics/file-utils.js";
import {
  EngineConnectPayloadSchema,
  normalizeEngineConnectPayload,
  stripLegacyUsbSentinels,
  toEngineConnectPayload,
} from "./engine-connect-schema.js";
import type { EngineConnectConfig } from "./engine-adapter-interface.js";

const CONNECTION_FILE = "engine-connection.json";

/**
 * Persisted last engine connection.
 *
 * On-disk shape (`<userData>/engine/engine-connection.json`) is the
 * EngineConnectPayloadSchema payload, not the adapter config: network
 * connections are `{ type, transport: "network", ip, port }`, USB connections
 * are `{ type, transport: "usb" }` without ip/port keys. Files written by
 * older bridges that still carry the USB sentinels (`ip: "", port: 0`) are
 * accepted on load and left untouched on disk.
 *
 * A connection choice belongs to the operator, not to the session: once made
 * it stays until the operator actively connects differently. The bridge uses
 * it to reconnect on startup, so a USB switcher is back without anyone having
 * to flip the webapp from network to USB after every restart.
 */
export class EngineConnectionStore {
  private filePath: string | null = null;

  private async resolveFilePath(): Promise<string> {
    if (this.filePath) {
      return this.filePath;
    }
    const { userDataDir } = getBridgeContext();
    const engineDir = path.join(userDataDir, "engine");
    await ensureDir(engineDir);
    this.filePath = path.join(engineDir, CONNECTION_FILE);
    return this.filePath;
  }

  /**
   * Persist the last successful connection.
   *
   * @param config Connection config as accepted by engine_connect.
   */
  async save(config: EngineConnectConfig): Promise<void> {
    try {
      const filePath = await this.resolveFilePath();
      await atomicWriteJson(filePath, toEngineConnectPayload(config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Engine] Failed to persist connection config: ${message}`
      );
    }
  }

  /**
   * Load the persisted connection, if any.
   *
   * @returns Validated config, or null when absent or invalid.
   */
  async load(): Promise<EngineConnectConfig | null> {
    try {
      const filePath = await this.resolveFilePath();
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = EngineConnectPayloadSchema.safeParse(
        stripLegacyUsbSentinels(JSON.parse(raw))
      );
      if (!parsed.success) {
        getBridgeContext().logger.warn(
          "[Engine] Persisted connection config invalid; ignoring"
        );
        return null;
      }
      return normalizeEngineConnectPayload(parsed.data);
    } catch {
      // Absent file is the normal first-run case.
      return null;
    }
  }
}

export const engineConnectionStore = new EngineConnectionStore();
