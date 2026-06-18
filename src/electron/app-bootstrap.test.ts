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

  it("migrates known user files plus the coupled bridge identity from the legacy template profile", async () => {
    const appDataPath = "/Users/test/Library/Application Support";
    const legacyUserDataPath = path.join(appDataPath, "electron-vite-template");
    const targetUserDataPath = path.join(appDataPath, "Broadify Bridge RC");
    const relayKeyRelPath = path.join("security", "relay-bridge-identity.json");
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === legacyUserDataPath) return true;
      if (targetPath.startsWith(targetUserDataPath)) return false;
      if (targetPath.endsWith("bridge-id.json")) return true;
      if (targetPath.endsWith("relay-bridge-identity.json")) return true;
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
    // Identity migrates as a unit: id + relay keypair (with its parent dir).
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, "bridge-id.json"),
      path.join(targetUserDataPath, "bridge-id.json"),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, relayKeyRelPath),
      path.join(targetUserDataPath, relayKeyRelPath),
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.dirname(path.join(targetUserDataPath, relayKeyRelPath)),
      { recursive: true },
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

  it("does NOT migrate the bridgeId when the legacy relay keypair is missing", async () => {
    // Guards the regression that bricked relay auth: migrating bridge-id.json
    // without security/relay-bridge-identity.json resurrects a bridgeId whose
    // keyId no longer matches the enrolled public key.
    const appDataPath = "/Users/test/Library/Application Support";
    const legacyUserDataPath = path.join(appDataPath, "electron-vite-template");
    const targetUserDataPath = path.join(appDataPath, "Broadify Bridge RC");
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === legacyUserDataPath) return true;
      if (targetPath.startsWith(targetUserDataPath)) return false;
      if (targetPath.endsWith("relay-bridge-identity.json")) return false; // keypair gone
      if (targetPath.endsWith("bridge-id.json")) return true;
      if (targetPath.endsWith("bridge-profile.json")) return true;
      if (targetPath.endsWith(".env")) return true;
      return false;
    });

    await import("./app-bootstrap.js");

    // Identity files must be skipped entirely (atomic-or-nothing).
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      path.join(legacyUserDataPath, "bridge-id.json"),
      path.join(targetUserDataPath, "bridge-id.json"),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("relay-bridge-identity.json"),
      expect.any(String),
    );
    // Non-identity files still migrate normally.
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, "bridge-profile.json"),
      path.join(targetUserDataPath, "bridge-profile.json"),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(legacyUserDataPath, ".env"),
      path.join(targetUserDataPath, ".env"),
    );
  });
});
