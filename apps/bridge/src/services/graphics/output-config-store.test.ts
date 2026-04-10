import fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { setBridgeContext } from "../bridge-context.js";
import { OutputConfigStore } from "./output-config-store.js";
import { GRAPHICS_OUTPUT_CONFIG_VERSION } from "./graphics-schemas.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";

const createValidConfig = () => ({
  version: GRAPHICS_OUTPUT_CONFIG_VERSION,
  outputKey: "video_hdmi" as const,
  targets: { output1Id: "display-1" },
  format: {
    width: 1920,
    height: 1080,
    fps: 50,
  },
  range: "legal" as const,
  colorspace: "auto" as const,
});

describe("OutputConfigStore", () => {
  let tempDir: string;
  let logger: {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "output-config-store-test-"));
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    setBridgeContext({
      userDataDir: tempDir,
      logPath: path.join(tempDir, "bridge.log"),
      logger,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads a persisted valid config from disk", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(createValidConfig(), null, 2),
      "utf-8"
    );

    await store.initialize();

    expect(store.getConfig()).toEqual(createValidConfig());
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("deletes invalid persisted config files", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          outputKey: "video_hdmi",
        },
        null,
        2
      ),
      "utf-8"
    );

    await store.initialize();

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(store.getConfig()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Graphics] Output config missing version; deleting"
    );
  });

  it("normalizes and persists configs, then removes them on clear", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");

    const migratedConfig: GraphicsOutputConfigT = {
      ...createValidConfig(),
      version: 999,
    };

    await store.setConfig(migratedConfig);

    const persisted = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(persisted.version).toBe(GRAPHICS_OUTPUT_CONFIG_VERSION);
    expect(store.getConfig()).toEqual(
      expect.objectContaining({
        version: GRAPHICS_OUTPUT_CONFIG_VERSION,
      })
    );

    await store.clear();

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(store.getConfig()).toBeNull();
  });

  it("deletes config when file contains non-object", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "null", "utf-8");

    await store.initialize();

    expect(store.getConfig()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Graphics] Output config invalid (not an object); deleting"
    );
  });

  it("deletes config when version is wrong", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...createValidConfig(), version: 99 }),
      "utf-8"
    );

    await store.initialize();

    expect(store.getConfig()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Output config version 99")
    );
  });

  it("deletes config when schema invalid", async () => {
    const store = new OutputConfigStore();
    const filePath = path.join(tempDir, "graphics", "graphics-output.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        outputKey: "invalid_key",
        targets: {},
        format: { width: 1920, height: 1080, fps: 30 },
      }),
      "utf-8"
    );

    await store.initialize();

    expect(store.getConfig()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Graphics] Output config schema invalid; deleting"
    );
  });

  it("handles missing file on load", async () => {
    const store = new OutputConfigStore();

    await store.initialize();

    expect(store.getConfig()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load output config")
    );
  });

  it("setConfig calls initialize when filePath not set", async () => {
    const store = new OutputConfigStore();

    await store.setConfig(createValidConfig());

    expect(store.getConfig()).toEqual(createValidConfig());
  });
});
