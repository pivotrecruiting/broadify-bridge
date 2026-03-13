import { ElectronRendererClient } from "./electron-renderer-client.js";

const mockResolveElectronBinary = jest.fn();
const mockResolveRendererEntry = jest.fn();
const mockDescribeBinary = jest.fn((p: string) => `path=${p}`);

jest.mock("./electron-renderer-launch.js", () => ({
  resolveElectronBinary: () => mockResolveElectronBinary(),
  resolveRendererEntry: () => mockResolveRendererEntry(),
  describeBinary: (p: string) => mockDescribeBinary(p),
}));

describe("ElectronRendererClient", () => {
  let client: ElectronRendererClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ElectronRendererClient();
  });

  describe("initialize", () => {
    it("throws when Electron binary is not found", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(client.initialize()).rejects.toThrow(
        "Electron binary not found for graphics renderer"
      );
    });

    it("throws when renderer entry is not found", async () => {
      mockResolveElectronBinary.mockReturnValue("/path/to/electron");
      mockResolveRendererEntry.mockReturnValue(null);
      await expect(client.initialize()).rejects.toThrow(
        "Electron renderer entry not found"
      );
    });
  });

  describe("shutdown", () => {
    it("resolves without throwing when never initialized", async () => {
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("onError", () => {
    it("accepts callback without throwing", () => {
      expect(() => client.onError(() => {})).not.toThrow();
    });
  });
});
