import path from "node:path";
import { resolveDisplayHelperPath } from "./display-helper.js";

const DISPLAY_HELPER_PATH_ENV = "BRIDGE_DISPLAY_HELPER_PATH";
const originalEnv = process.env;
const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;
const originalNodeEnv = process.env.NODE_ENV;

describe("display-helper", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      writable: true,
    });
    process.env.NODE_ENV = originalNodeEnv;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("resolveDisplayHelperPath", () => {
    it("returns env path when BRIDGE_DISPLAY_HELPER_PATH is set", () => {
      process.env[DISPLAY_HELPER_PATH_ENV] = "/custom/display-helper";

      const result = resolveDisplayHelperPath();

      expect(result).toBe("/custom/display-helper");
    });

    it("returns cwd-based path in dev (non-production)", () => {
      delete process.env[DISPLAY_HELPER_PATH_ENV];
      process.env.NODE_ENV = "development";
      Object.defineProperty(process, "resourcesPath", {
        value: "",
        writable: true,
      });

      const result = resolveDisplayHelperPath();

      const basename =
        process.platform === "win32" ? "display-helper.exe" : "display-helper";
      expect(result).toContain("native");
      expect(result).toContain("display-helper");
      expect(result.endsWith(basename)).toBe(true);
    });

    it("returns resources path in production when resourcesPath is set", () => {
      delete process.env[DISPLAY_HELPER_PATH_ENV];
      process.env.NODE_ENV = "production";
      Object.defineProperty(process, "resourcesPath", {
        value: "/app/resources",
        writable: true,
      });

      const result = resolveDisplayHelperPath();

      const basename =
        process.platform === "win32" ? "display-helper.exe" : "display-helper";
      expect(result).toBe(
        path.join("/app/resources", "native", "display-helper", basename)
      );
    });
  });
});
