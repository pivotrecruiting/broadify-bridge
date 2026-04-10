import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { AssetRegistry } from "./asset-registry.js";

jest.mock("../bridge-context.js", () => ({
  getBridgeContext: jest.fn(),
}));

const { getBridgeContext } = jest.requireMock("../bridge-context.js") as {
  getBridgeContext: jest.Mock;
};

describe("AssetRegistry", () => {
  let registry: AssetRegistry;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `asset-registry-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    getBridgeContext.mockReturnValue({ userDataDir: testDir });
    registry = new AssetRegistry();
    await registry.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const createAsset = (
    assetId: string,
    data: string,
    mime = "image/png"
  ) => ({
    assetId,
    name: "test-asset",
    mime,
    data,
  });

  describe("initialize", () => {
    it("creates assets directory and loads empty manifest", async () => {
      const assetsDir = path.join(testDir, "graphics-assets");
      await expect(fs.access(assetsDir)).resolves.toBeUndefined();
      expect(registry.getAsset("any")).toBeNull();
    });
  });

  describe("storeAsset", () => {
    it("stores asset and returns record with filePath", async () => {
      const base64 = Buffer.from([0x89, 0x50, 0x4e]).toString("base64");
      const record = await registry.storeAsset(
        createAsset("img-1", `data:image/png;base64,${base64}`)
      );

      expect(record.assetId).toBe("img-1");
      expect(record.name).toBe("test-asset");
      expect(record.mime).toBe("image/png");
      expect(record.size).toBe(3);
      expect(record.filePath).toContain("img-1.png");
      expect(record.createdAt).toBeDefined();
    });

    it("returns existing record when storing without data (update)", async () => {
      const base64 = Buffer.from([1, 2, 3]).toString("base64");
      const first = await registry.storeAsset(
        createAsset("img-2", `data:image/png;base64,${base64}`)
      );
      const second = await registry.storeAsset({
        assetId: "img-2",
        name: "test-asset",
        mime: "image/png",
      });

      expect(second).toEqual(first);
    });

    it("throws when asset not found and no data provided", async () => {
      await expect(
        registry.storeAsset({
          assetId: "missing",
          name: "x",
          mime: "image/png",
        })
      ).rejects.toThrow("Asset not found: missing");
    });

    it("throws when asset exceeds 10MB limit", async () => {
      const largeBase64 = "A".repeat(10 * 1024 * 1024 * (4 / 3) + 10);
      await expect(
        registry.storeAsset(createAsset("huge", largeBase64))
      ).rejects.toThrow("exceeds 10MB limit");
    });

    it("throws when total storage exceeds 100MB", async () => {
      const chunkSize = 9 * 1024 * 1024;
      const chunk = Buffer.alloc(chunkSize);
      const base64 = chunk.toString("base64");
      for (let i = 0; i < 11; i++) {
        await registry.storeAsset(createAsset(`big${i}`, base64));
      }
      await expect(
        registry.storeAsset(createAsset("big11", base64))
      ).rejects.toThrow("Total asset storage exceeds 100MB limit");
    });

    it("uses correct extension from mime type", async () => {
      const base64 = Buffer.from([1]).toString("base64");
      const png = await registry.storeAsset(
        createAsset("p1", base64, "image/png")
      );
      const jpg = await registry.storeAsset(
        createAsset("p2", base64, "image/jpeg")
      );
      const svg = await registry.storeAsset(
        createAsset("p3", base64, "image/svg+xml")
      );

      expect(png.filePath.endsWith(".png")).toBe(true);
      expect(jpg.filePath.endsWith(".jpg")).toBe(true);
      expect(svg.filePath.endsWith(".svg")).toBe(true);
    });
  });

  describe("getAsset", () => {
    it("returns null for unknown asset", () => {
      expect(registry.getAsset("unknown")).toBeNull();
    });

    it("returns record for stored asset", async () => {
      const base64 = Buffer.from([1]).toString("base64");
      await registry.storeAsset(createAsset("a1", base64));
      const record = registry.getAsset("a1");
      expect(record).not.toBeNull();
      expect(record!.assetId).toBe("a1");
    });
  });

  describe("getAssetMap", () => {
    it("returns map of assetId to filePath and mime", async () => {
      const base64 = Buffer.from([1]).toString("base64");
      await registry.storeAsset(createAsset("m1", base64));
      const map = registry.getAssetMap();
      expect(map["m1"]).toEqual(
        expect.objectContaining({
          filePath: expect.any(String),
          mime: "image/png",
        })
      );
    });
  });
});
