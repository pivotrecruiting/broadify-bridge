import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import { EngineConnectionStore } from "./engine-connection-store.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe("EngineConnectionStore", () => {
  let userDataDir: string;

  const connectionFilePath = () =>
    path.join(userDataDir, "engine", "engine-connection.json");

  beforeEach(async () => {
    jest.clearAllMocks();
    userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "engine-connection-store-")
    );
    setBridgeContext({
      userDataDir,
      logger: mockLogger,
      logPath: path.join(userDataDir, "bridge.log"),
    });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("persists a USB connection and loads it back as non-null", async () => {
    const store = new EngineConnectionStore();
    await store.save({ type: "atem", transport: "usb", ip: "", port: 0 });

    const loaded = await new EngineConnectionStore().load();

    expect(loaded).toEqual({ type: "atem", transport: "usb", ip: "", port: 0 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("writes the USB form without ip/port keys", async () => {
    await new EngineConnectionStore().save({
      type: "atem",
      transport: "usb",
      ip: "",
      port: 0,
    });

    const json = JSON.parse(
      await fs.readFile(connectionFilePath(), "utf-8")
    ) as Record<string, unknown>;

    expect(json).toEqual({ type: "atem", transport: "usb" });
    expect("ip" in json).toBe(false);
    expect("port" in json).toBe(false);
  });

  it("loads a legacy USB file containing ip/port sentinels", async () => {
    await fs.mkdir(path.dirname(connectionFilePath()), { recursive: true });
    await fs.writeFile(
      connectionFilePath(),
      JSON.stringify({ type: "atem", transport: "usb", ip: "", port: 0 }),
      "utf-8"
    );

    const loaded = await new EngineConnectionStore().load();

    expect(loaded).toEqual({ type: "atem", transport: "usb", ip: "", port: 0 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("round-trips a network connection", async () => {
    await new EngineConnectionStore().save({
      type: "vmix",
      transport: "network",
      ip: "192.168.1.20",
      port: 8088,
    });

    const json = JSON.parse(
      await fs.readFile(connectionFilePath(), "utf-8")
    ) as Record<string, unknown>;
    expect(json).toEqual({
      type: "vmix",
      transport: "network",
      ip: "192.168.1.20",
      port: 8088,
    });

    const loaded = await new EngineConnectionStore().load();
    expect(loaded).toEqual({
      type: "vmix",
      transport: "network",
      ip: "192.168.1.20",
      port: 8088,
    });
  });

  it("returns null and warns once for an invalid file", async () => {
    await fs.mkdir(path.dirname(connectionFilePath()), { recursive: true });
    await fs.writeFile(
      connectionFilePath(),
      JSON.stringify({ type: "atem", transport: "network", ip: "", port: 0 }),
      "utf-8"
    );

    const loaded = await new EngineConnectionStore().load();

    expect(loaded).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[Engine] Persisted connection config invalid; ignoring"
    );
  });

  it("returns null without warning when the file is missing", async () => {
    const loaded = await new EngineConnectionStore().load();

    expect(loaded).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
