import path from "node:path";
import { getAppLogDir, getAppLogPath, logAppInfo, logAppWarn, logAppError } from "./app-logger.js";

const testUserData = path.join(process.cwd(), "node_modules", ".app-logger-test");

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => testUserData) },
}));

const mockAppendFileSync = jest.fn();
const mockMkdirSync = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}));

describe("app-logger", () => {
  beforeEach(() => {
    mockAppendFileSync.mockClear();
    mockMkdirSync.mockClear();
  });

  describe("getAppLogDir", () => {
    it("returns log directory under userData", () => {
      expect(getAppLogDir()).toBe(path.join(testUserData, "logs"));
    });
  });

  describe("getAppLogPath", () => {
    it("returns path under userData/logs", () => {
      const result = getAppLogPath();
      expect(result).toBe(path.join(testUserData, "logs", "app.log"));
      expect(result).toContain("logs");
      expect(result).toContain("app.log");
    });
  });

  describe("logAppInfo, logAppWarn, logAppError", () => {
    it("writes log entries via stream", () => {
      logAppInfo("info message");
      logAppWarn("warn message");
      logAppError("error message");

      expect(mockMkdirSync).toHaveBeenCalledWith(path.join(testUserData, "logs"), {
        recursive: true,
      });
      expect(mockAppendFileSync).toHaveBeenCalled();
      const calls = mockAppendFileSync.mock.calls.map((c) => c[1]).join("");
      expect(calls).toContain("[INFO]");
      expect(calls).toContain("info message");
      expect(calls).toContain("[WARN]");
      expect(calls).toContain("warn message");
      expect(calls).toContain("[ERROR]");
      expect(calls).toContain("error message");
    });

    it("includes ISO timestamp in each line", () => {
      logAppInfo("test");
      const content = mockAppendFileSync.mock.calls.map((c) => c[1]).join("");
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
