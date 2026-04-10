jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/userData") },
}));

jest.mock("dotenv", () => ({
  config: jest.fn().mockReturnValue({ error: null }),
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

describe("loadAppEnv", () => {
  const originalResourcesPath = process.resourcesPath;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    const electron = await import("electron");
    (electron.app.getPath as jest.Mock).mockReturnValue("/tmp/userData");
    process.env.NODE_ENV = "test";
    process.resourcesPath = "";
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => "KEY=value");
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
});
