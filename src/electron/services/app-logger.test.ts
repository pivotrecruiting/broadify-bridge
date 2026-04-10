import path from "node:path";
import { getAppLogPath, logAppInfo, logAppWarn, logAppError } from "./app-logger.js";

const testUserData = path.join(process.cwd(), "node_modules", ".app-logger-test");

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => testUserData) },
}));

const mockWrite = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(() => ({
    write: mockWrite,
    end: jest.fn(),
  })),
}));

describe("app-logger", () => {
  beforeEach(() => {
    mockWrite.mockClear();
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

      expect(mockWrite).toHaveBeenCalled();
      const calls = mockWrite.mock.calls.map((c) => c[0]).join("");
      expect(calls).toContain("[INFO]");
      expect(calls).toContain("info message");
      expect(calls).toContain("[WARN]");
      expect(calls).toContain("warn message");
      expect(calls).toContain("[ERROR]");
      expect(calls).toContain("error message");
    });

    it("includes ISO timestamp in each line", () => {
      logAppInfo("test");
      const content = mockWrite.mock.calls.map((c) => c[0]).join("");
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
