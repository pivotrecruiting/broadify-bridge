const mockGetName = jest.fn();
const mockGetPath = jest.fn();
const mockSetName = jest.fn();
const mockSetPath = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockCopyFileSync = jest.fn();
const path = require("node:path") as typeof import("node:path");

jest.mock("electron", () => ({
  app: {
    getName: (...args: unknown[]) => mockGetName(...args),
    getPath: (...args: unknown[]) => mockGetPath(...args),
    setName: (...args: unknown[]) => mockSetName(...args),
    setPath: (...args: unknown[]) => mockSetPath(...args),
  },
}));

jest.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
}));

describe("app-bootstrap", () => {
  const originalExecPath = process.execPath;

  beforeEach(() => {
    jest.resetModules();
    mockGetName.mockReturnValue("electron-vite-template");
    mockGetPath.mockReturnValue("/Users/test/Library/Application Support");
    mockSetName.mockClear();
    mockSetPath.mockClear();
    mockExistsSync.mockReset();
    mockMkdirSync.mockClear();
    mockCopyFileSync.mockClear();
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/Applications/Broadify Bridge RC.app/Contents/MacOS/Broadify Bridge RC",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: originalExecPath,
    });
  });

  it("sets a dedicated RC app name and userData path before services load", async () => {
    mockExistsSync.mockReturnValue(false);
    const targetUserDataPath = path.join(
      "/Users/test/Library/Application Support",
      "Broadify Bridge RC",
    );

    await import("./app-bootstrap.js");

    expect(mockSetName).toHaveBeenCalledWith("Broadify Bridge RC");
    expect(mockSetPath).toHaveBeenCalledWith(
      "userData",
      targetUserDataPath,
    );
  });

  it("migrates only known user files from the legacy template profile", async () => {
    const appDataPath = "/Users/test/Library/Application Support";
    const legacyUserDataPath = path.join(appDataPath, "electron-vite-template");
    const targetUserDataPath = path.join(appDataPath, "Broadify Bridge RC");
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === legacyUserDataPath) return true;
      if (targetPath.startsWith(targetUserDataPath)) return false;
      if (targetPath.endsWith("bridge-id.json")) return true;
      if (targetPath.endsWith("bridge-profile.json")) return true;
      if (targetPath.endsWith(".env")) return true;
      if (targetPath.endsWith("network-config.json")) return false;
      return false;
    });

    await import("./app-bootstrap.js");

    expect(mockMkdirSync).toHaveBeenCalledWith(targetUserDataPath, {
      recursive: true,
    });
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, ".env"),
      path.join(targetUserDataPath, ".env"),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, "bridge-id.json"),
      path.join(targetUserDataPath, "bridge-id.json"),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, "bridge-profile.json"),
      path.join(targetUserDataPath, "bridge-profile.json"),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("GPUCache"),
      expect.any(String),
    );
  });
});
