import { existsSync, readFileSync } from "node:fs";
import { loadDefaultConfig } from "./default-config-loader.js";

jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const mockExistsSync = existsSync as jest.Mock;
const mockReadFileSync = readFileSync as jest.Mock;

describe("loadDefaultConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BRIDGE_GRAPHICS_RENDERER;
    delete process.env.BRIDGE_FRAMEBUS_NAME;
    delete process.env.BRIDGE_RELAY_JWKS_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does nothing when no config file exists", () => {
    mockExistsSync.mockReturnValue(false);
    loadDefaultConfig();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("loads packaged config when it exists", () => {
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, "/");
      return normalized.endsWith("/config/default.json") && !normalized.includes("../");
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        graphics: { renderer: "electron", framebusName: "main" },
      })
    );
    loadDefaultConfig();
    expect(process.env.BRIDGE_GRAPHICS_RENDERER).toBe("electron");
    expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("main");
  });

  it("loads dev config when packaged path does not exist", () => {
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        graphics: { framebusName: "dev-bus" },
      })
    );
    loadDefaultConfig();
    expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("dev-bus");
  });

  it("does not override existing env vars", () => {
    process.env.BRIDGE_GRAPHICS_RENDERER = "existing";
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        graphics: { renderer: "electron", framebusName: "main" },
      })
    );
    loadDefaultConfig();
    expect(process.env.BRIDGE_GRAPHICS_RENDERER).toBe("existing");
    expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("main");
  });

  it("applies relay jwksUrl when not set", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        graphics: {},
        relay: { jwksUrl: "https://relay.example.com/jwks" },
      })
    );
    loadDefaultConfig();
    expect(process.env.BRIDGE_RELAY_JWKS_URL).toBe("https://relay.example.com/jwks");
  });

  it("does nothing when config parse fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("parse error");
    });
    loadDefaultConfig();
    expect(process.env.BRIDGE_GRAPHICS_RENDERER).toBeUndefined();
  });

  it("does nothing when graphics section is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
    loadDefaultConfig();
    expect(process.env.BRIDGE_GRAPHICS_RENDERER).toBeUndefined();
  });
});
