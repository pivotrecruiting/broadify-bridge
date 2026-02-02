import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsAssetT } from "./graphics-schemas.js";
import { atomicWriteJson, ensureDir } from "./file-utils.js";

const ASSETS_DIR_NAME = "graphics-assets";
const ASSET_MANIFEST_FILE = "assets.json";
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export type AssetRecordT = {
  assetId: string;
  name: string;
  mime: string;
  size: number;
  filePath: string;
  createdAt: string;
};

function getExtensionFromMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/jpg") return ".jpg";
  if (normalized === "image/svg+xml") return ".svg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  return ".bin";
}

function decodeBase64(data: string): Buffer {
  const base64Index = data.indexOf("base64,");
  const raw = base64Index >= 0 ? data.slice(base64Index + 7) : data;
  return Buffer.from(raw, "base64");
}

/**
 * Disk-backed asset registry for graphics bundles.
 */
export class AssetRegistry {
  private assets = new Map<string, AssetRecordT>();
  private assetsDir: string | null = null;
  private manifestPath: string | null = null;
  private totalBytes = 0;

  /**
   * Initialize registry and load manifest from disk.
   *
   * @returns Promise resolved when manifest is loaded.
   */
  async initialize(): Promise<void> {
    const { userDataDir } = getBridgeContext();
    this.assetsDir = path.join(userDataDir, ASSETS_DIR_NAME);
    await ensureDir(this.assetsDir);
    this.manifestPath = path.join(this.assetsDir, ASSET_MANIFEST_FILE);

    await this.loadManifest();
  }

  /**
   * Store or update an asset.
   *
   * @param asset Asset payload (may include base64 data).
   * @returns Persisted asset record with file path and metadata.
   */
  async storeAsset(asset: GraphicsAssetT): Promise<AssetRecordT> {
    if (!this.assetsDir || !this.manifestPath) {
      await this.initialize();
    }

    const existing = this.assets.get(asset.assetId);
    if (!asset.data) {
      if (!existing) {
        throw new Error(`Asset not found: ${asset.assetId}`);
      }
      return existing;
    }

    const buffer = decodeBase64(asset.data);
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`Asset ${asset.assetId} exceeds 10MB limit`);
    }

    const nextTotal =
      this.totalBytes - (existing?.size || 0) + buffer.byteLength;
    if (nextTotal > MAX_TOTAL_BYTES) {
      throw new Error("Total asset storage exceeds 100MB limit");
    }

    const extension = getExtensionFromMime(asset.mime);
    const fileName = `${asset.assetId}${extension}`;
    const filePath = path.join(this.assetsDir as string, fileName);
    await fs.writeFile(filePath, buffer);

    const record: AssetRecordT = {
      assetId: asset.assetId,
      name: asset.name,
      mime: asset.mime,
      size: buffer.byteLength,
      filePath,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };

    this.assets.set(asset.assetId, record);
    this.totalBytes = nextTotal;

    await this.persistManifest();

    return record;
  }

  /**
   * Get asset record by id.
   *
   * @param assetId Asset identifier.
   * @returns Asset record or null if missing.
   */
  getAsset(assetId: string): AssetRecordT | null {
    return this.assets.get(assetId) || null;
  }

  /**
   * Get asset records as a map for protocol resolution.
   *
   * @returns Map of assetId to file path and mime type.
   */
  getAssetMap(): Record<string, { filePath: string; mime: string }> {
    const entries: Record<string, { filePath: string; mime: string }> = {};
    for (const [assetId, record] of this.assets.entries()) {
      entries[assetId] = { filePath: record.filePath, mime: record.mime };
    }
    return entries;
  }

  private async loadManifest(): Promise<void> {
    if (!this.manifestPath) {
      return;
    }

    try {
      const raw = await fs.readFile(this.manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as AssetRecordT[];
      this.assets.clear();
      this.totalBytes = 0;

      for (const record of manifest) {
        this.assets.set(record.assetId, record);
        this.totalBytes += record.size || 0;
      }
    } catch {
      this.assets.clear();
      this.totalBytes = 0;
    }
  }

  private async persistManifest(): Promise<void> {
    if (!this.manifestPath) {
      return;
    }

    const records = Array.from(this.assets.values());
    await atomicWriteJson(this.manifestPath, records);
  }
}

export const assetRegistry = new AssetRegistry();
