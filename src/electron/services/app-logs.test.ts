import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readAppLogs, clearAppLogs } from "./app-logs.js";
import { getAppLogPath } from "./app-logger.js";

jest.mock("./app-logger.js", () => ({
  getAppLogPath: jest.fn(),
}));

const mockGetAppLogPath = getAppLogPath as jest.Mock;

describe("app-logs", () => {
  let testLogPath: string;

  beforeEach(() => {
    testLogPath = path.join(os.tmpdir(), `app-logs-test-${Date.now()}.log`);
    mockGetAppLogPath.mockReturnValue(testLogPath);
  });

  afterEach(async () => {
    try {
      await fs.unlink(testLogPath);
    } catch {
      // ignore
    }
  });

  describe("readAppLogs", () => {
    it("returns empty when log file does not exist", async () => {
      mockGetAppLogPath.mockReturnValue("/nonexistent/path/app.log");
      await expect(readAppLogs()).resolves.toEqual({
        scope: "app",
        lines: 0,
        content: "",
      });
    });

    it("returns tail lines up to maxLines", async () => {
      const lines = ["line1", "line2", "line3", "line4", "line5"];
      await fs.writeFile(testLogPath, lines.join("\n"), "utf-8");
      const result = await readAppLogs({ lines: 2 });
      expect(result.scope).toBe("app");
      expect(result.lines).toBe(2);
      expect(result.content).toBe("line4\nline5");
    });

    it("applies filter case-insensitively", async () => {
      await fs.writeFile(
        testLogPath,
        "INFO foo\nWARN Bar\nERROR baz\nINFO BAR",
        "utf-8"
      );
      const result = await readAppLogs({ lines: 10, filter: "bar" });
      expect(result.lines).toBe(2);
      expect(result.content).toContain("WARN Bar");
      expect(result.content).toContain("INFO BAR");
    });

    it("clamps lines between 1 and 5000", async () => {
      await fs.writeFile(testLogPath, "single line", "utf-8");
      const result = await readAppLogs({ lines: 0 });
      expect(result.lines).toBe(1);
    });

    it("returns error on read failure (non-ENOENT)", async () => {
      const dirPath = path.join(os.tmpdir(), `app-logs-dir-${Date.now()}`);
      await fs.mkdir(dirPath, { recursive: true });
      mockGetAppLogPath.mockReturnValue(dirPath);
      const result = await readAppLogs();
      expect(result.scope).toBe("app");
      expect(result.lines).toBe(0);
      expect(result.content).toBe("");
      expect(result.error).toBeDefined();
      await fs.rm(dirPath, { recursive: true, force: true });
    });
  });

  describe("clearAppLogs", () => {
    it("clears log file and returns cleared true", async () => {
      await fs.writeFile(testLogPath, "existing content", "utf-8");
      const result = await clearAppLogs();
      expect(result).toEqual({ scope: "app", cleared: true });
      const content = await fs.readFile(testLogPath, "utf-8");
      expect(content).toBe("");
    });

    it("returns cleared false when log path is a directory", async () => {
      const dirAsLogPath = path.join(os.tmpdir(), `app-logs-dir-as-file-${Date.now()}`);
      await fs.mkdir(dirAsLogPath, { recursive: true });
      mockGetAppLogPath.mockReturnValue(dirAsLogPath);
      const result = await clearAppLogs();
      expect(result.scope).toBe("app");
      expect(result.cleared).toBe(false);
      expect(result.error).toBeDefined();
      await fs.rm(dirAsLogPath, { recursive: true, force: true });
    });
  });
});
