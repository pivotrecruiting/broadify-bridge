const mockCpuUsage = jest.fn((cb: (n: number) => void) => cb(0.25));
const mockTotalmem = jest.fn(() => 16384);
const mockFreememPercentage = jest.fn(() => 0.75);

jest.mock("os-utils", () => ({
  __esModule: true,
  default: {
    cpuUsage: mockCpuUsage,
    totalmem: mockTotalmem,
    freememPercentage: mockFreememPercentage,
  },
}));

const mockStatfsSync = jest.fn().mockReturnValue({
  bsize: 4096,
  blocks: 1_000_000,
  bfree: 250_000,
});

jest.mock("fs", () => ({
  statfsSync: (path: string) => mockStatfsSync(path),
}));

const mockCpus = jest.fn().mockReturnValue([{ model: "Test CPU" }]);
jest.mock("os", () => ({
  cpus: () => mockCpus(),
}));

const mockIpcWebContentsSend = jest.fn();
jest.mock("./util.js", () => ({
  ipcWebContentsSend: (...args: unknown[]) => mockIpcWebContentsSend(...args),
}));

import { pollResources, getStaticData } from "./test.js";

describe("test (system stats)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCpuUsage.mockImplementation((cb: (n: number) => void) => cb(0.25));
    mockStatfsSync.mockReturnValue({
      bsize: 4096,
      blocks: 1_000_000,
      bfree: 250_000,
    });
  });

  describe("getStaticData", () => {
    it("returns totalStorage, cpuModel, totalMemoryGB", () => {
      const result = getStaticData();
      expect(result).toMatchObject({
        totalStorage: expect.any(Number),
        cpuModel: "Test CPU",
        totalMemoryGB: expect.any(Number),
      });
      expect(result.totalStorage).toBeGreaterThan(0);
      expect(result.totalMemoryGB).toBeGreaterThan(0);
    });

    it("uses root path on non-win32", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      getStaticData();
      expect(mockStatfsSync).toHaveBeenCalledWith("/");
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("uses C: on win32", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      getStaticData();
      expect(mockStatfsSync).toHaveBeenCalledWith("C://");
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });

  describe("pollResources", () => {
    it("sends statistics via IPC at interval", async () => {
      jest.useFakeTimers();
      const mockWebContents = {} as Electron.WebContents;
      pollResources({ webContents: mockWebContents } as Electron.BrowserWindow);
      await jest.advanceTimersByTimeAsync(600);
      expect(mockIpcWebContentsSend).toHaveBeenCalledWith(
        "statistics",
        mockWebContents,
        expect.objectContaining({
          cpuUsage: expect.any(Number),
          ramUsage: expect.any(Number),
          storageData: expect.any(Number),
        })
      );
      jest.useRealTimers();
    });
  });
});
