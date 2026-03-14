import { readFileSync } from "node:fs";
import { getRuntimeAppVersion } from "./runtime-app-version.js";

jest.mock("node:fs", () => ({
  readFileSync: jest.fn(),
}));

const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>;

describe("runtime-app-version", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BROADIFY_DESKTOP_APP_VERSION;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns env version when BROADIFY_DESKTOP_APP_VERSION is set", () => {
    process.env.BROADIFY_DESKTOP_APP_VERSION = "1.2.3";
    expect(getRuntimeAppVersion()).toBe("1.2.3");
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("trims whitespace from env version", () => {
    process.env.BROADIFY_DESKTOP_APP_VERSION = "  2.0.0  ";
    expect(getRuntimeAppVersion()).toBe("2.0.0");
  });

  it("falls back to package.json when env is empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.5.0" }));
    expect(getRuntimeAppVersion()).toBe("0.5.0");
  });

  it("tries next path when first package.json fails", () => {
    mockReadFileSync
      .mockImplementationOnce(() => {
        throw new Error("ENOENT");
      })
      .mockReturnValueOnce(JSON.stringify({ version: "3.0.0" }));
    expect(getRuntimeAppVersion()).toBe("3.0.0");
  });

  it("returns default when all package paths fail", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getRuntimeAppVersion()).toBe("0.1.0");
  });

  it("skips package without version field", () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({ name: "foo" }))
      .mockReturnValueOnce(JSON.stringify({ version: "1.0.0" }));
    expect(getRuntimeAppVersion()).toBe("1.0.0");
  });
});
