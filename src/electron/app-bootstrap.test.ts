const mockGetName = jest.fn();
const mockGetPath = jest.fn();
const mockSetName = jest.fn();
const mockSetPath = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockCopyFileSync = jest.fn();

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

    await import("./app-bootstrap.js");

    expect(mockSetName).toHaveBeenCalledWith("Broadify Bridge RC");
    expect(mockSetPath).toHaveBeenCalledWith(
      "userData",
      "/Users/test/Library/Application Support/Broadify Bridge RC",
    );
  });

  it("migrates only known user files from the legacy template profile", async () => {
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath.endsWith("electron-vite-template")) return true;
      if (targetPath.includes("Broadify Bridge RC")) return false;
      if (targetPath.endsWith("bridge-id.json")) return true;
      if (targetPath.endsWith("bridge-profile.json")) return true;
      if (targetPath.endsWith(".env")) return true;
      if (targetPath.endsWith("network-config.json")) return false;
      return false;
    });

    await import("./app-bootstrap.js");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/Broadify Bridge RC",
      { recursive: true },
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/electron-vite-template/.env",
      "/Users/test/Library/Application Support/Broadify Bridge RC/.env",
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/electron-vite-template/bridge-id.json",
      "/Users/test/Library/Application Support/Broadify Bridge RC/bridge-id.json",
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/electron-vite-template/bridge-profile.json",
      "/Users/test/Library/Application Support/Broadify Bridge RC/bridge-profile.json",
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("GPUCache"),
      expect.any(String),
    );
  });
});
