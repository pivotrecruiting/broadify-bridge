import path from "path";
import {
  getPreloadPathCore,
  getUIPathCore,
  getIconPathCore,
} from "./path-resolver-core.js";

describe("path-resolver-core", () => {
  const mockExistsSync = jest.fn();

  describe("getPreloadPathCore", () => {
    it("returns dev path when isDev is true", () => {
      const result = getPreloadPathCore(
        "/app/asar/dist-electron",
        "/app",
        true,
        "darwin",
        mockExistsSync,
        false
      );
      expect(result).toBe(path.join("/app", "dist-electron", "preload.cjs"));
    });

    it("returns production path when isDev is false", () => {
      const result = getPreloadPathCore(
        "/app/asar/dist-electron",
        "/app",
        false,
        "darwin",
        mockExistsSync,
        false
      );
      expect(result).toBe(path.join("/app/asar/dist-electron", "preload.cjs"));
    });

    it("logs path and existence when logPreloadPath is true", () => {
      mockExistsSync.mockReturnValue(true);
      const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      getPreloadPathCore(
        "/app/asar/dist-electron",
        "/app",
        false,
        "darwin",
        mockExistsSync,
        true
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "[Preload] Path:",
        expect.stringContaining("preload.cjs"),
        "exists:",
        true
      );
      consoleSpy.mockRestore();
    });
  });

  describe("getUIPathCore", () => {
    it("returns path with dist-react/index.html", () => {
      const result = getUIPathCore("/app");
      expect(result).toBe(path.join("/app", "/dist-react/index.html"));
    });
  });

  describe("getIconPathCore", () => {
    it("returns icon path for non-win32", () => {
      const result = getIconPathCore("/app", false, "darwin");
      expect(result).toContain("icon.png");
    });

    it("returns icon path for win32", () => {
      const result = getIconPathCore("/app", false, "win32");
      expect(result).toContain("icon.png");
    });

    it("returns different path for dev vs production", () => {
      const prod = getIconPathCore("/app", false, "darwin");
      const dev = getIconPathCore("/app", true, "darwin");
      expect(prod).toContain("icon.png");
      expect(dev).toContain("icon.png");
      expect(prod).not.toBe(dev);
    });
  });
});
