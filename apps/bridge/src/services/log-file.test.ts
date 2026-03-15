import { mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { ensureBridgeLogFile } from "./log-file.js";

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn(),
  stat: jest.fn(),
  rename: jest.fn(),
}));

const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockRename = rename as jest.MockedFunction<typeof rename>;

describe("log-file", () => {
  const userDataDir = "/tmp/bridge-data";

  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
  });

  describe("ensureBridgeLogFile", () => {
    it("creates log dir and returns log path when file does not exist", async () => {
      mockStat.mockRejectedValue({ code: "ENOENT" });

      const result = await ensureBridgeLogFile(userDataDir);

      const expectedLogPath = path.join(userDataDir, "logs", "bridge.log");
      expect(result).toBe(expectedLogPath);
      expect(mockMkdir).toHaveBeenCalledWith(
        path.join(userDataDir, "logs"),
        { recursive: true }
      );
      expect(mockRename).not.toHaveBeenCalled();
    });

    it("returns log path when file exists and is under size limit", async () => {
      mockStat.mockResolvedValue({ size: 1024 } as Awaited<ReturnType<typeof stat>>);

      const result = await ensureBridgeLogFile(userDataDir);

      const expectedLogPath = path.join(userDataDir, "logs", "bridge.log");
      expect(result).toBe(expectedLogPath);
      expect(mockRename).not.toHaveBeenCalled();
    });

    it("rotates log file when it exceeds size limit", async () => {
      mockStat.mockResolvedValue({
        size: 6 * 1024 * 1024,
      } as Awaited<ReturnType<typeof stat>>);
      mockRename.mockResolvedValue(undefined);

      const result = await ensureBridgeLogFile(userDataDir);

      const expectedLogPath = path.join(userDataDir, "logs", "bridge.log");
      expect(result).toBe(expectedLogPath);
      expect(mockRename).toHaveBeenCalledWith(
        expectedLogPath,
        expect.stringMatching(/\/tmp\/bridge-data\/logs\/bridge-\d+\.log$/)
      );
    });

    it("throws on non-ENOENT stat errors", async () => {
      mockStat.mockRejectedValue(new Error("Permission denied"));

      await expect(ensureBridgeLogFile(userDataDir)).rejects.toThrow(
        "Permission denied"
      );
    });
  });
});
