import fs from "node:fs";
import {
  describeBinary,
  resolveElectronBinary,
  resolveRendererEntry,
} from "./electron-renderer-launch.js";

jest.mock("node:fs");
const mockResolve = jest.fn();
jest.mock("node:path", () => ({
  ...jest.requireActual("node:path"),
  resolve: (...args: string[]) => mockResolve(...args),
}));

const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

describe("electron-renderer-launch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("describeBinary", () => {
    it("returns message for empty path", () => {
      expect(describeBinary("")).toBe("path is empty");
    });

    it("returns missing when path does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      expect(describeBinary("/nonexistent/binary")).toBe(
        "missing (/nonexistent/binary)"
      );
    });

    it("returns path, size and mode when file exists", () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({
        size: 12345,
        mode: 0o755,
      } as fs.Stats);
      const result = describeBinary("/usr/bin/electron");
      expect(result).toContain("path=/usr/bin/electron");
      expect(result).toContain("size=12345");
      expect(result).toContain("mode=");
    });

    it("returns unreadable when statSync throws", () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        throw new Error("EACCES");
      });
      const result = describeBinary("/restricted/file");
      expect(result).toContain("unreadable");
      expect(result).toContain("EACCES");
    });
  });

  describe("resolveElectronBinary", () => {
    const originalExecPath = process.execPath;
    const originalCwd = process.cwd;
    const originalPlatform = process.platform;
    const originalEnv = process.env.ELECTRON_RUN_AS_NODE;

    afterEach(() => {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
      process.cwd = originalCwd;
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      if (originalEnv !== undefined) {
        process.env.ELECTRON_RUN_AS_NODE = originalEnv;
      } else {
        delete process.env.ELECTRON_RUN_AS_NODE;
      }
    });

    it("returns process.execPath when ELECTRON_RUN_AS_NODE is 1 and execPath is not plain node", () => {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      Object.defineProperty(process, "execPath", {
        value: "/Applications/Broadify Bridge.app/Contents/MacOS/Broadify Bridge",
        configurable: true,
      });
      const result = resolveElectronBinary();
      expect(result).toBe(process.execPath);
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it("does not trust ELECTRON_RUN_AS_NODE when execPath is a plain node binary", () => {
      // VSCode-spawned terminals leak ELECTRON_RUN_AS_NODE=1 into plain node
      // dev runs; trusting it would spawn node with Electron flags and break
      // the graphics renderer.
      process.env.ELECTRON_RUN_AS_NODE = "1";
      Object.defineProperty(process, "execPath", {
        value: "/usr/local/bin/node",
        configurable: true,
      });
      const resolvedPath = "/project/root/node_modules/.bin/electron";
      mockResolve.mockReturnValue(resolvedPath);
      mockExistsSync.mockImplementation((p: string) => p === resolvedPath);
      const result = resolveElectronBinary();
      expect(result).toBe(resolvedPath);
    });

    it("returns process.execPath when execPath contains electron", () => {
      delete process.env.ELECTRON_RUN_AS_NODE;
      Object.defineProperty(process, "execPath", {
        value: "/path/to/electron",
        configurable: true,
      });
      const result = resolveElectronBinary();
      expect(result).toBe("/path/to/electron");
    });

    it("returns candidate from node_modules/.bin when it exists", () => {
      delete process.env.ELECTRON_RUN_AS_NODE;
      Object.defineProperty(process, "execPath", {
        value: "/usr/bin/node",
        configurable: true,
      });
      const resolvedPath = "/project/root/node_modules/.bin/electron";
      mockResolve.mockReturnValue(resolvedPath);
      mockExistsSync.mockImplementation((p: string) => p === resolvedPath);
      const result = resolveElectronBinary();
      expect(result).toBe(resolvedPath);
    });

    it("returns null when candidate does not exist", () => {
      delete process.env.ELECTRON_RUN_AS_NODE;
      Object.defineProperty(process, "execPath", {
        value: "/usr/bin/node",
        configurable: true,
      });
      const resolvedPath = "/project/root/node_modules/.bin/electron";
      mockResolve.mockReturnValue(resolvedPath);
      mockExistsSync.mockReturnValue(false);
      const result = resolveElectronBinary();
      expect(result).toBeNull();
    });
  });

  describe("resolveRendererEntry", () => {
    it("returns dist entry path when file exists", () => {
      const distPath =
        "/cwd/dist/services/graphics/renderer/electron-renderer-entry.js";
      mockResolve.mockReturnValue(distPath);
      mockExistsSync.mockImplementation((p: string) => p === distPath);
      const result = resolveRendererEntry();
      expect(result).toBe(distPath);
    });

    it("returns null when dist entry does not exist", () => {
      const distPath =
        "/cwd/dist/services/graphics/renderer/electron-renderer-entry.js";
      mockResolve.mockReturnValue(distPath);
      mockExistsSync.mockReturnValue(false);
      const result = resolveRendererEntry();
      expect(result).toBeNull();
    });
  });
});
