import path from "path";

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/tmp/userData"),
    isPackaged: false,
  },
}));

const mockDotenvConfig = jest.fn().mockReturnValue({ error: null });
jest.mock("dotenv", () => ({
  config: (...args: unknown[]) => mockDotenvConfig(...args),
  parse: (src: Buffer | string) =>
    jest.requireActual<typeof import("dotenv")>("dotenv").parse(src),
}));

const mockLogAppInfo = jest.fn();
jest.mock("./app-logger.js", () => ({
  logAppInfo: (...args: unknown[]) => mockLogAppInfo(...args),
}));

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn().mockImplementation(() => "KEY=value");
const mockCopyFileSync = jest.fn();
jest.mock("fs", () => ({
  ...jest.requireActual<typeof import("fs")>("fs"),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
}));

type MockElectronAppT = {
  getPath: jest.Mock;
  isPackaged: boolean;
};

const PROJECT_ENV = path.join(process.cwd(), ".env");
const USER_ENV = path.join("/tmp/userData", ".env");

const configuredPaths = (): string[] =>
  mockDotenvConfig.mock.calls.map(
    (call) => (call[0] as { path: string }).path,
  );

describe("loadAppEnv", () => {
  const originalResourcesPath = process.resourcesPath;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    const electron = await import("electron");
    const app = electron.app as unknown as MockElectronAppT;
    app.getPath.mockReturnValue("/tmp/userData");
    app.isPackaged = false;
    process.env.NODE_ENV = "test";
    process.resourcesPath = "";
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => "KEY=value");
    mockDotenvConfig.mockReturnValue({ error: null });
  });

  afterEach(() => {
    process.resourcesPath = originalResourcesPath;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("calls app.getPath when loading env", async () => {
    const { app } = await import("electron");
    const { loadAppEnv } = await import("./env-loader.js");

    loadAppEnv();

    expect(app.getPath).toHaveBeenCalledWith("userData");
  });

  it("is idempotent: second call returns early without calling getPath again", async () => {
    const { app } = await import("electron");
    const { loadAppEnv } = await import("./env-loader.js");

    loadAppEnv();
    const getPathCallsAfterFirst = (app.getPath as jest.Mock).mock.calls.length;
    loadAppEnv();
    const getPathCallsAfterSecond = (app.getPath as jest.Mock).mock.calls.length;

    expect(getPathCallsAfterSecond).toBe(getPathCallsAfterFirst);
  });

  it("attempts to load env from candidate paths", async () => {
    mockExistsSync.mockReturnValue(false);

    const { loadAppEnv } = await import("./env-loader.js");
    loadAppEnv();

    expect(mockExistsSync).toHaveBeenCalled();
  });

  it("does not consult cwd/.env when packaged", async () => {
    const electron = await import("electron");
    (electron.app as unknown as MockElectronAppT).isPackaged = true;
    process.resourcesPath = "/res";
    mockExistsSync.mockReturnValue(true);

    const { loadAppEnv } = await import("./env-loader.js");
    loadAppEnv();

    expect(mockExistsSync).not.toHaveBeenCalledWith(PROJECT_ENV);
    expect(configuredPaths()).not.toContain(PROJECT_ENV);
    expect(configuredPaths()).toEqual([
      USER_ENV,
      path.join("/res", "bridge", "dist", ".env"),
      path.join("/res", "bridge", ".env"),
    ]);
  });

  it("loads the project .env first when not packaged", async () => {
    process.resourcesPath = "/res";
    mockExistsSync.mockReturnValue(true);

    const { loadAppEnv } = await import("./env-loader.js");
    loadAppEnv();

    expect(configuredPaths()).toEqual([
      PROJECT_ENV,
      USER_ENV,
      path.join("/res", "bridge", "dist", ".env"),
      path.join("/res", "bridge", ".env"),
    ]);
  });

  it("logs userData env key names without values", async () => {
    const electron = await import("electron");
    (electron.app as unknown as MockElectronAppT).isPackaged = true;
    mockExistsSync.mockImplementation((p: string) => p === USER_ENV);
    mockReadFileSync.mockImplementation((p: string) =>
      p === USER_ENV ? "B=secret\nA=1\n" : "",
    );

    const { loadAppEnv } = await import("./env-loader.js");
    loadAppEnv();

    expect(mockLogAppInfo).toHaveBeenCalledTimes(1);
    const message = mockLogAppInfo.mock.calls[0][0] as string;
    expect(message).toContain("userData/.env keys: A, B");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("=1");
  });

  it("does not log when userData/.env is empty", async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_ENV);
    mockReadFileSync.mockImplementation(() => "");

    const { loadAppEnv } = await import("./env-loader.js");
    loadAppEnv();

    expect(mockLogAppInfo).not.toHaveBeenCalled();
  });
  it("lets the packaged PRODUCTION_STUDIO_CONTROL_WEBAPP_URL win over userData/.env", async () => {
    const electron = await import("electron");
    (electron.app as unknown as MockElectronAppT).isPackaged = true;
    process.resourcesPath = "/res";
    const packagedEnv = path.join("/res", "bridge", "dist", ".env");
    mockExistsSync.mockImplementation(
      (candidate: unknown) => candidate === USER_ENV || candidate === packagedEnv,
    );
    mockReadFileSync.mockImplementation((candidate: unknown) =>
      candidate === packagedEnv
        ? "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL=https://packaged.example.test\nBRIDGE_LOG_LEVEL=info\n"
        : "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL=https://user.example.test\nBRIDGE_LOG_LEVEL=debug\n",
    );
    // dotenv.config is mocked, so emulate what it would have loaded from the
    // (earlier, winning) userData/.env before the release-managed pass runs.
    process.env.PRODUCTION_STUDIO_CONTROL_WEBAPP_URL = "https://user.example.test";
    process.env.BRIDGE_LOG_LEVEL = "debug";

    try {
      const { loadAppEnv } = await import("./env-loader.js");
      loadAppEnv();

      // Release-managed: the packaged value always wins, so a userData/.env
      // written by a stable install cannot keep an RC build on the prod web app.
      expect(process.env.PRODUCTION_STUDIO_CONTROL_WEBAPP_URL).toBe(
        "https://packaged.example.test",
      );
      // Not release-managed: userData keeps winning (override: false).
      expect(process.env.BRIDGE_LOG_LEVEL).toBe("debug");
    } finally {
      delete process.env.PRODUCTION_STUDIO_CONTROL_WEBAPP_URL;
      delete process.env.BRIDGE_LOG_LEVEL;
    }
  });
});
