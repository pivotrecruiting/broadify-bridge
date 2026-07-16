const mockGetName = jest.fn();
const mockGetPath = jest.fn();
const mockSetName = jest.fn();
const mockSetPath = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockCopyFileSync = jest.fn();
const path = require("node:path") as typeof import("node:path");
let mockIsPackaged = true;

jest.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
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
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    mockIsPackaged = true;
    mockGetName.mockReturnValue("electron-vite-template");
    mockGetPath.mockReturnValue("/Users/test/Library/Application Support");
    mockSetName.mockClear();
    mockSetPath.mockClear();
    mockExistsSync.mockReset();
    mockMkdirSync.mockClear();
    mockCopyFileSync.mockReset();
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/Applications/Broadify Bridge RC.app/Contents/MacOS/Broadify Bridge RC",
    });
  });

  afterEach(() => {
    delete process.env.BRIDGE_GRAPHICS_USER_DATA_DIR;
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: originalExecPath,
    });
    Object.defineProperty(process, "argv", {
      configurable: true,
      value: originalArgv,
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

  it("gives an unpackaged dev run its own app name and userData path", async () => {
    // The dev run executes the bare Electron binary, so it matches neither
    // product name and would otherwise share the production profile.
    mockIsPackaged = false;
    mockExistsSync.mockReturnValue(false);
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    });

    await import("./app-bootstrap.js");

    expect(mockSetName).toHaveBeenCalledWith("Broadify Bridge Dev");
    expect(mockSetPath).toHaveBeenCalledWith(
      "userData",
      path.join("/Users/test/Library/Application Support", "Broadify Bridge Dev"),
    );
  });

  it("seeds the dev profile with production settings but never its identity", async () => {
    // A copied bridgeId would leave the dev run and an installed build enrolled
    // as the same bridge -- the very conflict the split profile prevents.
    mockIsPackaged = false;
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    });
    const appDataPath = "/Users/test/Library/Application Support";
    const productionUserDataPath = path.join(appDataPath, "Broadify Bridge");
    const devUserDataPath = path.join(appDataPath, "Broadify Bridge Dev");
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath.startsWith(devUserDataPath)) return false; // dev profile is empty
      if (targetPath === productionUserDataPath) return true;
      if (targetPath.endsWith("electron-vite-template")) return false; // legacy already gone
      if (targetPath.endsWith("bridge-id.json")) return true;
      if (targetPath.endsWith("relay-bridge-identity.json")) return true;
      if (targetPath.endsWith(".env")) return true;
      if (targetPath.endsWith("bridge-profile.json")) return true;
      return false;
    });

    await import("./app-bootstrap.js");

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(productionUserDataPath, ".env"),
      path.join(devUserDataPath, ".env"),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(productionUserDataPath, "bridge-profile.json"),
      path.join(devUserDataPath, "bridge-profile.json"),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("bridge-id.json"),
      expect.any(String),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("relay-bridge-identity.json"),
      expect.any(String),
    );
  });

  it("seeds the dev profile from the production profile, not a stale legacy file", async () => {
    // Migration only fills gaps, so the first source wins. Seeding after the
    // legacy pass handed the dev profile a months-old .env still pointing at the
    // production relay, which cannot see the local webapp.
    mockIsPackaged = false;
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    });
    const appDataPath = "/Users/test/Library/Application Support";
    const legacyUserDataPath = path.join(appDataPath, "electron-vite-template");
    const productionUserDataPath = path.join(appDataPath, "Broadify Bridge");
    const devUserDataPath = path.join(appDataPath, "Broadify Bridge Dev");
    // Model the real filesystem: once a file is copied it exists, which is what
    // makes the later legacy pass skip it. Without this the ordering is untestable.
    const copiedTargets = new Set<string>();
    mockCopyFileSync.mockImplementation((_source: string, target: string) => {
      copiedTargets.add(target);
    });
    // Both sources hold a .env; the production one must win.
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (copiedTargets.has(targetPath)) return true;
      if (targetPath.startsWith(devUserDataPath)) return false;
      if (targetPath === productionUserDataPath || targetPath === legacyUserDataPath) return true;
      if (targetPath.endsWith(".env")) return true;
      return false;
    });

    await import("./app-bootstrap.js");

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(productionUserDataPath, ".env"),
      path.join(devUserDataPath, ".env"),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      path.join(legacyUserDataPath, ".env"),
      path.join(devUserDataPath, ".env"),
    );
  });

  it("uses the explicit graphics renderer userData path without legacy migration", async () => {
    process.env.BRIDGE_GRAPHICS_USER_DATA_DIR =
      "/Users/test/Library/Application Support/Broadify Bridge/graphics-renderer-profile";
    Object.defineProperty(process, "argv", {
      configurable: true,
      value: ["electron", "/app", "--graphics-renderer"],
    });

    await import("./app-bootstrap.js");

    expect(mockSetPath).toHaveBeenCalledWith(
      "userData",
      "/Users/test/Library/Application Support/Broadify Bridge/graphics-renderer-profile",
    );
    expect(mockSetName).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
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
