import { mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { ensureBridgeLogFile } from "./log-file.js";

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn(),
  stat: jest.fn(),
  rename: jest.fn(),
}));

const mockMkdir = mkdir as jest.Mock;
const mockStat = stat as jest.Mock;
const mockRename = rename as jest.Mock;

describe("ensureBridgeLogFile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
  });

  it("creates log dir and returns log path when file does not exist", async () => {
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });
    const result = await ensureBridgeLogFile("/tmp/bridge-data");
    expect(result).toBe(path.join("/tmp/bridge-data", "logs", "bridge.log"));
    expect(mockMkdir).toHaveBeenCalledWith(
      path.join("/tmp/bridge-data", "logs"),
      { recursive: true }
    );
  });

  it("returns log path when file exists and is under size limit", async () => {
    mockStat.mockResolvedValueOnce({ size: 1000 });
    const result = await ensureBridgeLogFile("/tmp/bridge-data");
    expect(result).toBe(path.join("/tmp/bridge-data", "logs", "bridge.log"));
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("rotates log when file exceeds 5MB", async () => {
    mockStat.mockResolvedValueOnce({ size: 6 * 1024 * 1024 });
    const result = await ensureBridgeLogFile("/tmp/bridge-data");
    expect(result).toBe(path.join("/tmp/bridge-data", "logs", "bridge.log"));
    expect(mockRename).toHaveBeenCalledWith(
      path.join("/tmp/bridge-data", "logs", "bridge.log"),
      expect.stringMatching(/\/tmp\/bridge-data\/logs\/bridge-\d+\.log$/)
    );
  });

  it("throws when stat fails with non-ENOENT error", async () => {
    mockStat.mockRejectedValueOnce(new Error("EACCES"));
    await expect(ensureBridgeLogFile("/tmp/bridge-data")).rejects.toThrow(
      "EACCES"
    );
  });
});
